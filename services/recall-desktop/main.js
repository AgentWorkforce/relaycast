/**
 * recall-desktop — minimal bot-free meeting recorder (Granola-style) for the
 * pilot. Embeds @recallai/desktop-sdk: records locally on the prospect's Mac,
 * no bot joins the call. On meeting end the SDK uploads to Recall, which fires
 * `sdk_upload.complete` at the transcription-worker → NB-Whisper → agent.
 *
 * The Recall API key is NEVER here — the app asks the worker to mint each upload
 * (POST /recall/create-upload), so the desktop client only holds a shared token.
 *
 * Config via env (or a .env next to this file):
 *   WORKER_URL            https://<transcription-worker>.workers.dev
 *   RECORDER_TRANSCRIBE_TOKEN  matches the worker's RECORDER_TRANSCRIBE_TOKEN secret
 *   RECALL_API_URL        region base, e.g. https://us-west-2.recall.ai
 *
 * Run:  npm install && npm start
 * Package later (signed/notarized) with electron-builder for distribution.
 *
 * NOTE: SDK method/event names below follow Recall's Desktop SDK docs
 * (init / "meeting-detected" / startRecording). Verify against the current
 * @recallai/desktop-sdk quickstart when you wire it up.
 */
const { app } = require('electron');
const RecallAiSdk = require('@recallai/desktop-sdk');

const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/+$/, '');
const SHARED_TOKEN = process.env.RECORDER_TRANSCRIBE_TOKEN || '';
const RECALL_API_URL = process.env.RECALL_API_URL || 'https://us-west-2.recall.ai';

async function createUpload() {
  const res = await fetch(`${WORKER_URL}/recall/create-upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SHARED_TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`create-upload ${res.status}: ${await res.text()}`);
  return res.json(); // { id, upload_token }
}

app.whenReady().then(() => {
  if (!WORKER_URL || !SHARED_TOKEN) {
    console.error('Set WORKER_URL and RECORDER_TRANSCRIBE_TOKEN'); app.quit(); return;
  }

  RecallAiSdk.init({ apiUrl: RECALL_API_URL });
  console.log('recall-desktop ready — listening for meetings (bot-free).');

  // The SDK detects a meeting window. Mint an upload, then start recording.
  RecallAiSdk.addEventListener('meeting-detected', async (evt) => {
    try {
      const { upload_token } = await createUpload();
      RecallAiSdk.startRecording({ windowId: evt.window.id, uploadToken: upload_token });
      console.log('recording started (local, no bot) for window', evt.window.id);
    } catch (err) {
      console.error('failed to start recording:', err);
    }
  });

  // Optional: surface lifecycle for debugging. Recording auto-uploads on end;
  // the worker hears `sdk_upload.complete` and runs the pipeline.
  RecallAiSdk.addEventListener('recording-ended', () => console.log('recording ended — uploading…'));
  RecallAiSdk.addEventListener('error', (e) => console.error('recall sdk error:', e));
});

app.on('window-all-closed', () => {}); // tray-style: keep running with no window
