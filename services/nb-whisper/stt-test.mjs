#!/usr/bin/env node
/**
 * stt-test — throw one audio file at multiple speech-to-text engines and compare
 * the transcripts side by side. This is the dialect proof point: feed a real
 * Ålesund / Sunnmøre call recording and eyeball which engine actually
 * understands it before committing to a pipeline.
 *
 * Engines (each runs only if its key/URL is set — missing ones are skipped):
 *   modal      NB-Whisper on Modal (our endpoint)  env: MODAL_NBWHISPER_URL, MODAL_NBWHISPER_TOKEN
 *   deepgram   Nova-3, language=no                 env: DEEPGRAM_API_KEY
 *   nbwhisper  NB-Whisper large (HF Inference)     env: HF_API_TOKEN
 *   soniox     async transcription                 env: SONIOX_API_KEY
 *
 * Each transcript is printed (preview) and written in full to
 *   scripts/.stt-out/<audiobasename>.<engine>.txt
 * so you can diff them or read them against what was actually said.
 *
 * Usage:
 *   DEEPGRAM_API_KEY=... node scripts/stt-test.mjs ./call.wav
 *   DEEPGRAM_API_KEY=... HF_API_TOKEN=... node scripts/stt-test.mjs ./call.m4a
 *   node scripts/stt-test.mjs ./call.wav --lang no --engines deepgram,nbwhisper
 *
 * Notes:
 *   - Norwegian language code is `no`. Override with --lang.
 *   - NB-Whisper on HF serverless can cold-start (503 "loading"); the script
 *     waits and retries. For repeated runs, a dedicated HF endpoint is faster.
 */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { basename, extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '.stt-out');

const MIME = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
  '.aac': 'audio/aac',
};

function parseArgs(argv) {
  const args = { file: null, lang: 'no', engines: ['modal', 'deepgram', 'nbwhisper', 'soniox'] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lang') args.lang = argv[++i];
    else if (a === '--engines') args.engines = argv[++i].split(',').map((s) => s.trim());
    else if (!a.startsWith('--')) args.file = a;
  }
  return args;
}

const wordCount = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);
const ms = (start) => `${((performance.now() - start) / 1000).toFixed(1)}s`;

// ── Modal NB-Whisper (our serverless endpoint) ───────────────────────────────
async function modal(audio, mime) {
  const url = process.env.MODAL_NBWHISPER_URL;
  const token = process.env.MODAL_NBWHISPER_TOKEN;
  if (!url) return { skipped: 'MODAL_NBWHISPER_URL not set' };
  const endpoint = url.replace(/\/+$/, '') + '/transcribe';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token ?? ''}`, 'Content-Type': mime },
    body: audio,
  });
  if (!res.ok) throw new Error(`modal ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return { text: json?.text ?? '' };
}

// ── Deepgram ────────────────────────────────────────────────────────────────
async function deepgram(audio, mime, lang) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return { skipped: 'DEEPGRAM_API_KEY not set' };
  const url = `https://api.deepgram.com/v1/listen?model=nova-3&language=${lang}&punctuate=true&diarize=true&paragraphs=true`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': mime },
    body: audio,
  });
  if (!res.ok) throw new Error(`deepgram ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const alt = json?.results?.channels?.[0]?.alternatives?.[0] ?? {};
  const text = alt?.paragraphs?.transcript || alt?.transcript || '';
  return { text };
}

// ── NB-Whisper via Hugging Face Inference ─────────────────────────────────────
async function nbwhisper(audio, mime) {
  const key = process.env.HF_API_TOKEN || process.env.HUGGINGFACE_API_KEY;
  if (!key) return { skipped: 'HF_API_TOKEN not set' };
  const url = 'https://api-inference.huggingface.co/models/NbAiLab/nb-whisper-large';
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': mime, 'x-wait-for-model': 'true' },
      body: audio,
    });
    if (res.status === 503) {
      const body = await res.json().catch(() => ({}));
      const wait = Math.min(Math.ceil(body?.estimated_time ?? 20), 60);
      process.stderr.write(`  nbwhisper: model loading, waiting ${wait}s…\n`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`nbwhisper ${res.status}: ${await res.text()}`);
    const json = await res.json();
    return { text: Array.isArray(json) ? json[0]?.text ?? '' : json?.text ?? '' };
  }
  throw new Error('nbwhisper: model still loading after retries');
}

// ── Soniox (async: upload → create → poll) ───────────────────────────────────
async function soniox(audio, mime, lang, fileName) {
  const key = process.env.SONIOX_API_KEY;
  if (!key) return { skipped: 'SONIOX_API_KEY not set' };
  const auth = { Authorization: `Bearer ${key}` };

  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), fileName);
  const up = await fetch('https://api.soniox.com/v1/files', { method: 'POST', headers: auth, body: form });
  if (!up.ok) throw new Error(`soniox upload ${up.status}: ${await up.text()}`);
  const fileId = (await up.json())?.id;

  const create = await fetch('https://api.soniox.com/v1/transcriptions', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId, model: 'stt-async-preview', language_hints: [lang] }),
  });
  if (!create.ok) throw new Error(`soniox create ${create.status}: ${await create.text()}`);
  const id = (await create.json())?.id;

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await fetch(`https://api.soniox.com/v1/transcriptions/${id}`, { headers: auth });
    const j = await st.json();
    if (j?.status === 'completed') break;
    if (j?.status === 'error') throw new Error(`soniox: ${j?.error_message ?? 'failed'}`);
  }
  const tr = await fetch(`https://api.soniox.com/v1/transcriptions/${id}/transcript`, { headers: auth });
  if (!tr.ok) throw new Error(`soniox transcript ${tr.status}: ${await tr.text()}`);
  const j = await tr.json();
  const text = j?.text || (j?.tokens ?? []).map((t) => t.text).join('');
  return { text };
}

const ENGINES = { modal, deepgram, nbwhisper, soniox };

async function main() {
  const { file, lang, engines } = parseArgs(process.argv.slice(2));
  if (!file) {
    console.error('usage: node scripts/stt-test.mjs <audio-file> [--lang no] [--engines deepgram,nbwhisper,soniox]');
    process.exit(1);
  }
  await stat(file).catch(() => {
    console.error(`file not found: ${file}`);
    process.exit(1);
  });

  const audio = await readFile(file);
  const ext = extname(file).toLowerCase();
  const mime = MIME[ext] ?? 'application/octet-stream';
  const name = basename(file);
  await mkdir(OUT_DIR, { recursive: true });

  console.log(`\n🎧 ${name}  (${(audio.length / 1e6).toFixed(1)} MB, ${mime}, lang=${lang})\n`);

  const results = [];
  for (const eng of engines) {
    const fn = ENGINES[eng];
    if (!fn) {
      console.log(`• ${eng}: unknown engine, skipping`);
      continue;
    }
    const start = performance.now();
    try {
      const out = await fn(audio, mime, lang, name);
      if (out.skipped) {
        console.log(`• ${eng}: skipped (${out.skipped})`);
        continue;
      }
      const outPath = join(OUT_DIR, `${name}.${eng}.txt`);
      await writeFile(outPath, out.text);
      results.push({ eng, text: out.text, took: ms(start), outPath });
      console.log(`✓ ${eng}  ${ms(start)}  ${wordCount(out.text)} words  → ${outPath}`);
    } catch (err) {
      console.log(`✗ ${eng}: ${err.message}`);
    }
  }

  for (const r of results) {
    console.log(`\n${'─'.repeat(72)}\n${r.eng.toUpperCase()}  (${r.took}, ${wordCount(r.text)} words)\n${'─'.repeat(72)}`);
    console.log(r.text.slice(0, 1500) + (r.text.length > 1500 ? '\n… [full transcript in ' + r.outPath + ']' : ''));
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
