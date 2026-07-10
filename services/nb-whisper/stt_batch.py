#!/usr/bin/env python3
"""
stt_batch — run NB-Whisper vs vanilla Whisper on several clips, side by side.

No ground truth needed to learn something: where the two models DIVERGE is where
the dialect is genuinely hard and NB-Whisper's National-Library tuning earns its
keep. Where they AGREE, the clip was easy. Loads each model once, then loops.

Usage:
    python3 scripts/stt_batch.py .stt-samples/*.wav
"""
import sys
import time
import glob

import torch
from transformers import pipeline

NB = "NbAiLab/nb-whisper-medium"
VANILLA = "openai/whisper-medium"
device = "mps" if torch.backends.mps.is_available() else "cpu"

paths = []
for a in sys.argv[1:]:
    paths.extend(sorted(glob.glob(a)))
if not paths:
    paths = sorted(glob.glob(".stt-samples/*.wav"))

print(f"device={device}  nb={NB}  vanilla={VANILLA}\n", flush=True)


def load(model):
    return pipeline("automatic-speech-recognition", model=model, dtype=torch.float32, device=device)


def run(asr, path):
    out = asr(path, chunk_length_s=28, batch_size=1,
              generate_kwargs={"language": "no", "task": "transcribe"})
    return out["text"].strip()


t = time.time()
nb = load(NB)
vanilla = load(VANILLA)
print(f"[models loaded in {time.time()-t:.0f}s]\n", flush=True)

for p in paths:
    name = p.split("/")[-1]
    print("#" * 78)
    print(f"# {name}")
    print("#" * 78)
    nb_txt = run(nb, p)
    va_txt = run(vanilla, p)
    print(f"\nNB-Whisper:\n{nb_txt}\n")
    print(f"Vanilla Whisper:\n{va_txt}\n")
