# Nova speaker embedding worker

This private Modal service runs SpeechBrain ECAPA-TDNN outside Vercel. It accepts one authenticated, ephemeral audio request and returns only a normalized speaker embedding. It does not retain audio.

Deployment requires a separate Preview-only Modal environment and a secret named `nova-speaker-preview` containing `NOVA_SPEAKER_WORKER_TOKEN`. Deploy with `modal deploy speaker-worker/modal_app.py`, then configure the Git-backed Vercel Preview with `NOVA_SPEAKER_EXTRACTOR_URL`, the matching `NOVA_SPEAKER_EXTRACTOR_TOKEN`, `NOVA_SPEAKER_EXTRACTOR_MODEL=speechbrain/spkrec-ecapa-voxceleb@ecapa-v1`, plus independent random 32-byte-or-longer `NOVA_SPEAKER_EMBEDDING_KEY` and `NOVA_SPEAKER_ASSERTION_KEY` values.

Do not enroll anyone until that person has read the disclosure and personally consented. Enrollment audio is transient; derived voiceprints are sensitive biometric data and remain outside Nova memories and model prompts.
