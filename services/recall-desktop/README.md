# recall-desktop — bot-free meeting recorder (pilot)

Granola-style local capture: records the prospect's meetings **on their Mac, with
no bot in the call**, using Recall's Desktop Recording SDK. Feeds the
`transcription-worker` → NB-Whisper → meeting-actions agent.

## Flow

```
meeting starts → SDK fires "meeting-detected"
  → app POSTs worker /recall/create-upload (Bearer shared token; Recall key stays server-side)
  → worker returns { upload_token }
  → SDK startRecording({ windowId, uploadToken })   ← local, invisible
meeting ends → SDK uploads to Recall
  → Recall fires sdk_upload.complete → worker → NB-Whisper → granola note → agent
```

## Run (dev)

```sh
cd cloud/services/recall-desktop
npm install
WORKER_URL=https://<worker>.workers.dev \
RECORDER_TRANSCRIBE_TOKEN=<matches worker secret> \
RECALL_API_URL=https://us-west-2.recall.ai \
npm start
```

For the prospect: package a signed/notarized build with `electron-builder` and
hand him the `.app`. For a single-user pilot you can run unsigned locally.

## Consent

Bot-free = no visible participant, **not** covert. Recording still requires
disclosure/consent (Norway/EU GDPR). Keep a "this meeting is being recorded"
notice in the app and have him disclose.

## Verify against Recall docs

SDK calls here (`init`, `meeting-detected`, `startRecording`, `windowId`,
`uploadToken`) follow Recall's Desktop SDK docs — confirm exact names against the
current `@recallai/desktop-sdk` quickstart before shipping.
