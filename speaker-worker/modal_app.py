"""Ephemeral speaker-embedding worker. Raw audio is decoded in memory and never persisted."""
import base64
import io
import os
import tempfile

import modal

MODEL_ID = "speechbrain/spkrec-ecapa-voxceleb"
MODEL_VERSION = "speechbrain/spkrec-ecapa-voxceleb@ecapa-v1"
app = modal.App("nova-speaker-embedding-preview")
image = modal.Image.debian_slim(python_version="3.11").apt_install("ffmpeg").pip_install(
    "fastapi[standard]==0.116.1", "requests==2.32.5", "speechbrain==1.0.3", "torch==2.7.1", "torchaudio==2.7.1"
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
                waveform = waveform.mean(dim=0, keepdim=True)
                if rate != 16000:
                    waveform = torchaudio.functional.resample(waveform, rate, 16000)
                speech_seconds = waveform.shape[-1] / 16000
                if speech_seconds < 2.0:
                    raise HTTPException(status_code=422, detail="Insufficient speech")
                samples = waveform.squeeze(0)
                frames = samples.unfold(0, 480, 160)
                frame_rms = frames.square().mean(dim=1).sqrt()
                noise_floor = torch.quantile(frame_rms, 0.2)
                active_threshold = max(0.008, float(noise_floor) * 3.0)
                voiced_seconds = float((frame_rms >= active_threshold).sum()) * 0.01
                clipping_ratio = float((samples.abs() >= 0.995).float().mean())
                if voiced_seconds < 1.0 or clipping_ratio > 0.02:
                    raise HTTPException(status_code=422, detail="Insufficient speech quality")
                with torch.inference_mode():
                    vector = self.encoder.encode_batch(waveform).squeeze().cpu().tolist()
                return {"embedding": vector, "model": MODEL_VERSION, "speechSeconds": round(voiced_seconds, 3), "quality": "accepted"}
            finally:
                if path:
                    try: os.unlink(path)
                    except OSError: pass

        return api
