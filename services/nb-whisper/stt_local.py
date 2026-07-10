#!/usr/bin/env python3
"""
stt_local — run NB-Whisper locally (no API key, no cloud) to test dialect
accuracy on an audio file. Uses Apple Silicon MPS when available.

Usage:
    python3 scripts/stt_local.py <audio-file> [model] [language]
    # model: NbAiLab/nb-whisper-{tiny,base,small,medium,large}
    #        or *-semantic / *-verbatim variants. Default: nb-whisper-medium
    # language default: no

Example:
    python3 scripts/stt_local.py .stt-samples/sunnmore-intense.wav
"""
import sys
import time

import torch
from transformers import pipeline

audio = sys.argv[1] if len(sys.argv) > 1 else ".stt-samples/sunnmore-intense.wav"
model = sys.argv[2] if len(sys.argv) > 2 else "NbAiLab/nb-whisper-medium"
language = sys.argv[3] if len(sys.argv) > 3 else "no"

device = "mps" if torch.backends.mps.is_available() else "cpu"
print(f"model={model}  device={device}  language={language}\naudio={audio}", flush=True)

t0 = time.time()
asr = pipeline(
    "automatic-speech-recognition",
    model=model,
    torch_dtype=torch.float32,  # float32 is safest on MPS
    device=device,
)
load_s = time.time() - t0

t1 = time.time()
try:
    out = asr(
        audio,
        chunk_length_s=28,
        batch_size=1,
        return_timestamps=False,
        generate_kwargs={"language": language, "task": "transcribe"},
    )
except Exception as exc:  # MPS op gaps → retry on CPU
    print(f"[{device} failed: {exc}; retrying on cpu]", flush=True)
    asr = pipeline("automatic-speech-recognition", model=model, torch_dtype=torch.float32, device="cpu")
    out = asr(audio, chunk_length_s=28, batch_size=1, generate_kwargs={"language": language, "task": "transcribe"})
infer_s = time.time() - t1

print("\n" + "=" * 72)
print(f"TRANSCRIPT  (load {load_s:.0f}s, infer {infer_s:.0f}s)")
print("=" * 72)
print(out["text"].strip())
print()
