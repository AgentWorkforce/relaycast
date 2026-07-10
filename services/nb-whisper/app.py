"""
nb-whisper — serverless NB-Whisper transcription on Modal.

The dialect-accurate STT endpoint for the meeting-actions pipeline. Cloudflare
can't run GPU PyTorch weights (Workers AI only serves vanilla Whisper, which is
exactly what fails on the Ålesund/Sunnmøre dialect), so the model lives here on a
serverless L4 that scales to zero between calls. The Cloudflare Worker
(packages/transcription-worker) calls this over HTTPS.

Why NB-Whisper: National Library of Norway model, trained on 66k hours across
Norway's dialects (Møre included), Apache-2.0 (resale OK). `-large-semantic`
normalizes messy dialect speech into clean written Norwegian — ideal for action
items. Swap MODEL via the NB_WHISPER_MODEL env on the Modal secret.

Deploy:
    pip install modal
    modal token new                                  # one-time auth
    modal secret create nb-whisper-auth AUTH_TOKEN=$(openssl rand -hex 32)
    modal deploy app.py                              # prints the https URL

Test (raw bytes):
    curl -X POST "$MODAL_URL/transcribe?language=no" \
      -H "Authorization: Bearer $AUTH_TOKEN" \
      -H "Content-Type: audio/wav" --data-binary @call.wav

Test (URL — e.g. a Recall pre-signed S3 link):
    curl -X POST "$MODAL_URL/transcribe" \
      -H "Authorization: Bearer $AUTH_TOKEN" \
      -H "Content-Type: application/json" -d '{"url":"https://.../call.m4a"}'
"""
import os

import modal

# nb-whisper-large = dialect-accurate verbatim; -large-semantic = cleaned for minutes.
# The default model when a language has no specialist checkpoint (and for the
# legacy NB_WHISPER_MODEL override).
DEFAULT_MODEL = os.environ.get("NB_WHISPER_MODEL", "NbAiLab/nb-whisper-large")

# Per-language specialist checkpoints — national-library Whisper fine-tunes that
# beat the default on that language's dialects. One Modal deploy serves all of
# them: `Whisper(model=...)` gives each checkpoint its own auto-scaling container
# pool (idle languages scale to zero — no separate deploy per language).
#
# Only list languages whose best model DIFFERS from DEFAULT_MODEL. Anything not
# here (Norwegian no/nb/nn, Danish, …) falls back to DEFAULT_MODEL, so the
# operator-configured NB_WHISPER_MODEL deploy default is always respected — e.g.
# deploying with NB_WHISPER_MODEL=...-semantic keeps Norwegian on that semantic
# model rather than being silently reverted to nb-whisper-large.
#
# The transcription-worker mirrors this map and is authoritative for routing; it
# only sends an explicit `model` for these specialists. This copy is the fallback
# so direct callers (curl, the test script) route correctly by `language` alone.
LANGUAGE_MODELS = {
    "sv": "KBLab/kb-whisper-large",     # Swedish — National Library of Sweden
}


def model_for(language: str | None, model: str | None) -> str:
    """Resolve the checkpoint: explicit `model` wins, else map by language, else default."""
    if model:
        return model
    if language and language != "auto":
        return LANGUAGE_MODELS.get(language, DEFAULT_MODEL)
    return DEFAULT_MODEL


app = modal.App("nb-whisper")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")  # decodes wav/m4a/mp3/mp4 for the pipeline
    .pip_install(
        "transformers==4.44.2",
        "torch==2.4.0",
        "accelerate==0.34.2",
        "soundfile==0.12.1",
        "librosa==0.10.2",
        "httpx==0.27.2",
        "fastapi[standard]==0.115.0",
    )
)

# Persist HF weight downloads so cold starts don't re-pull ~3GB every time.
hf_cache = modal.Volume.from_name("nb-whisper-hf-cache", create_if_missing=True)
auth = modal.Secret.from_name("nb-whisper-auth")  # provides AUTH_TOKEN (+ optional NB_WHISPER_MODEL)


@app.cls(
    gpu="L4",  # 24GB — plenty for whisper-large fp16; ~$0.84/hr, billed per-second
    image=image,
    volumes={"/cache": hf_cache},
    scaledown_window=120,  # stay warm 2min after a call, then scale to zero
    timeout=1800,
)
class Whisper:
    # One container pool per distinct model value. Callers select the checkpoint
    # with Whisper(model="KBLab/kb-whisper-large"); each pool scales to zero on
    # its own, so unused languages cost nothing.
    model: str = modal.parameter(default=DEFAULT_MODEL)

    @modal.enter()
    def load(self):
        import torch
        from transformers import pipeline

        self.pipe = pipeline(
            "automatic-speech-recognition",
            model=self.model,
            torch_dtype=torch.float16,
            device="cuda",
            model_kwargs={"cache_dir": "/cache"},
        )

    @modal.method()
    def run(self, audio: bytes, language) -> str:
        generate_kwargs = {"task": "transcribe"}
        # None or "auto" → Whisper detects language from audio.
        # Any other value (e.g. "no") → forced language (dialect-accurate path).
        if language and language != "auto":
            generate_kwargs["language"] = language
        out = self.pipe(
            audio,
            chunk_length_s=28,  # whisper's 30s window, with overlap headroom
            batch_size=16,
            return_timestamps=False,
            generate_kwargs=generate_kwargs,
        )
        return out["text"].strip()


@app.function(image=image, secrets=[auth], scaledown_window=300, timeout=1800)
@modal.asgi_app()
def web():
    # All FastAPI imports stay inside the function so `modal deploy` needs no
    # local fastapi install — they resolve inside the image at runtime.
    import httpx
    from fastapi import FastAPI, HTTPException, Request

    api = FastAPI(title="nb-whisper")

    @api.post("/transcribe")
    async def transcribe(request: Request):
        if request.headers.get("authorization") != f"Bearer {os.environ['AUTH_TOKEN']}":
            raise HTTPException(status_code=401, detail="unauthorized")

        language = request.query_params.get("language", "no")
        model = request.query_params.get("model")
        ctype = request.headers.get("content-type", "")

        if ctype.startswith("application/json"):
            body = await request.json()
            url = body.get("url")
            language = body.get("language", language)
            model = body.get("model", model)
            if not url:
                raise HTTPException(status_code=400, detail="json body must include {url}")
            async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
                resp = await client.get(url)
                resp.raise_for_status()
                audio = resp.content
        else:
            audio = await request.body()
            if not audio:
                raise HTTPException(status_code=400, detail="empty body; send audio bytes or JSON {url}")

        resolved = model_for(language, model)
        text = Whisper(model=resolved).run.remote(audio, language)
        return {"text": text, "model": resolved, "language": language}

    # OpenAI-compatible transcription shim — OpenWhispr points cloudTranscriptionBaseUrl
    # at https://<modal-app>/v1 and OpenWhispr appends /audio/transcriptions automatically.
    # Auth: same Bearer AUTH_TOKEN (OpenWhispr sends it as-is); model/language params ignored
    # (we always force NB-Whisper with language=no for Norwegian dialect accuracy).
    @api.post("/v1/audio/transcriptions")
    async def openai_transcriptions(request: Request):
        from fastapi import UploadFile, Form
        from fastapi.datastructures import FormData

        auth = request.headers.get("authorization", "")
        if auth != f"Bearer {os.environ['AUTH_TOKEN']}":
            raise HTTPException(status_code=401, detail="unauthorized")

        ctype = request.headers.get("content-type", "")
        if "multipart/form-data" in ctype:
            form: FormData = await request.form()
            file_field = form.get("file")
            if file_field is None:
                raise HTTPException(status_code=400, detail="multipart must include 'file' field")
            if hasattr(file_field, "read"):
                audio = await file_field.read()
            else:
                audio = file_field.encode() if isinstance(file_field, str) else bytes(file_field)
        else:
            # Fallback: raw bytes body (same as /transcribe)
            audio = await request.body()

        if not audio:
            raise HTTPException(status_code=400, detail="no audio data received")

        text = Whisper(model=DEFAULT_MODEL).run.remote(audio, "no")
        # OpenAI spec: {"text": "..."}
        return {"text": text}

    @api.get("/health")
    def health():
        return {"ok": True, "default_model": DEFAULT_MODEL, "language_models": LANGUAGE_MODELS}

    return api
