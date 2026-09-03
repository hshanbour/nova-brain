"""Ephemeral speaker-embedding worker. Raw audio is decoded in memory and never persisted."""
import base64
import io
import json
import os
import tempfile

import modal

MODEL_ID = "speechbrain/spkrec-ecapa-voxceleb"
MODEL_VERSION = "speechbrain/spkrec-ecapa-voxceleb@ecapa-v1"
PREPROCESSING_VERSION = "decode-mono-16k-rms-vad-v2"
app = modal.App("nova-speaker-embedding-preview")
image = modal.Image.debian_slim(python_version="3.11").apt_install("ffmpeg").pip_install(
    "fastapi[standard]==0.116.1", "requests==2.32.5", "huggingface_hub==0.24.7", "speechbrain==1.0.3", "torch==2.7.1", "torchaudio==2.7.1"
)


def _authorize(request):
    expected = os.environ.get("NOVA_SPEAKER_WORKER_TOKEN", "")
    supplied = request.headers.get("authorization", "")
    if not expected or supplied != f"Bearer {expected}":
        from fastapi import HTTPException
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.cls(image=image, cpu=2, memory=4096, scaledown_window=300, secrets=[modal.Secret.from_name("nova-speaker-preview")])
@modal.concurrent(max_inputs=8)
class SpeakerEmbedding:
    @modal.enter()
    def load(self):
        from speechbrain.inference.speaker import EncoderClassifier
        self.encoder = EncoderClassifier.from_hparams(source=MODEL_ID, savedir="/tmp/ecapa")

    @modal.asgi_app()
    def api(self):
        from fastapi import FastAPI, HTTPException, Request
        import torch
        import torchaudio

        api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

        @api.post("/readiness")
        async def readiness(request: Request):
            _authorize(request)
            return {"ready": True, "model": MODEL_VERSION, "rawAudioPolicy": "ephemeral-request-only"}

        @api.post("/embed")
        async def embed(request: Request):
            _authorize(request)
            print(json.dumps({"event": "speaker_embed_received", "requestId": request.headers.get("x-nova-request-id"), "enrollmentAttemptId": request.headers.get("x-nova-enrollment-attempt-id")}))
            payload = await request.json()
            try:
                raw = base64.b64decode(payload["audioBase64"], validate=True)
            except Exception as exc:
                raise HTTPException(status_code=400, detail="Invalid audio") from exc
            if not raw or len(raw) > 2 * 1024 * 1024:
                raise HTTPException(status_code=400, detail="Invalid audio size")
            suffix = {"audio/webm": ".webm", "audio/webm;codecs=opus": ".webm", "audio/ogg": ".ogg", "audio/ogg;codecs=opus": ".ogg", "audio/mp4": ".mp4", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav"}.get(payload.get("mimeType"))
            if not suffix:
                raise HTTPException(status_code=415, detail="Unsupported audio type")
            path = None
            try:
                with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
                    handle.write(raw); path = handle.name
                waveform, rate = torchaudio.load(path)
                original_rate = int(rate)
                channel_count = int(waveform.shape[0])
                waveform = waveform.mean(dim=0, keepdim=True)
                if rate != 16000:
                    waveform = torchaudio.functional.resample(waveform, rate, 16000)
                total_seconds = waveform.shape[-1] / 16000
                diagnostics = {"totalDurationSeconds": round(total_seconds, 3), "sampleRate": original_rate, "channelCount": channel_count, "preprocessingVersion": PREPROCESSING_VERSION}
                if total_seconds < 1.0:
                    return {"quality": "rejected", "reason": "insufficient_total_audio", "model": MODEL_VERSION, **diagnostics, "speechSeconds": 0, "silenceRatio": 1}
                samples = waveform.squeeze(0)
                frames = samples.unfold(0, 480, 160)
                frame_rms = frames.square().mean(dim=1).sqrt()
                noise_floor = torch.quantile(frame_rms, 0.2)
                active_threshold = max(0.0025, min(0.02, float(noise_floor) * 2.0))
                active = frame_rms >= active_threshold
                voiced_seconds = float(active.sum()) * 0.01
                silence_ratio = max(0.0, min(1.0, 1.0 - voiced_seconds / max(total_seconds, 0.001)))
                clipping_ratio = float((samples.abs() >= 0.995).float().mean())
                diagnostics.update({"speechSeconds": round(voiced_seconds, 3), "silenceRatio": round(silence_ratio, 3)})
                if voiced_seconds < 1.0:
                    return {"quality": "rejected", "reason": "insufficient_voiced_speech", "model": MODEL_VERSION, **diagnostics}
                if clipping_ratio > 0.02:
                    return {"quality": "rejected", "reason": "excessive_clipping", "model": MODEL_VERSION, **diagnostics}
                # Expand active frames by 100 ms on each side, then concatenate
                # only speech-bearing samples. This removes arbitrary endpoint
                # silence while retaining phonetic transitions for ECAPA.
                expanded = active.clone()
                for offset in range(1, 11):
                    expanded[offset:] |= active[:-offset]
                    expanded[:-offset] |= active[offset:]
                sample_mask = torch.zeros(samples.shape[-1], dtype=torch.bool, device=samples.device)
                for index in torch.nonzero(expanded, as_tuple=False).flatten().tolist():
                    start = index * 160
                    sample_mask[start:min(start + 480, sample_mask.numel())] = True
                speech = samples[sample_mask]
                speech = speech - speech.mean()
                speech_rms = speech.square().mean().sqrt().clamp_min(1e-6)
                gain = max(0.5, min(5.0, 0.08 / float(speech_rms)))
                speech = (speech * gain).clamp(-0.98, 0.98).unsqueeze(0)
                with torch.inference_mode():
                    vector = self.encoder.encode_batch(speech).squeeze().cpu().tolist()
                completed = {"event": "speaker_embed_completed", "requestId": request.headers.get("x-nova-request-id"), "enrollmentAttemptId": request.headers.get("x-nova-enrollment-attempt-id"), **diagnostics, "quality": "accepted"}
                print(json.dumps(completed))
                return {"embedding": vector, "model": MODEL_VERSION, "quality": "accepted", **diagnostics}
            finally:
                if path:
                    try: os.unlink(path)
                    except OSError: pass

        return api
