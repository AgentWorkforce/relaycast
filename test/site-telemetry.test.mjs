import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source = readFileSync(new URL('../site/script.js', import.meta.url), 'utf8').split('function sanitizeUrl')[0];
function harness(dnt = '0') {
  const storage = new Map([['relaycast_posthog_distinct_id', 'old-anonymous']]);
  const sent = []; let sequence = 0;
  const sandbox = { window: { POSTHOG_API_KEY: 'phc_test', crypto: { randomUUID: () => `random-${++sequence}` }, location: { pathname: '/', hostname: 'test' } },
    navigator: { doNotTrack: dnt }, document: { querySelector: () => null },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: (_url, options) => { sent.push(JSON.parse(options.body)); return Promise.resolve(); }, Blob };
  vm.runInNewContext(source + '\nglobalThis.subject = telemetry;', sandbox);
  return { sandbox, sent, storage };
}
test('website emits anonymous personless events and honors runtime DNT with rotation', () => {
  const { sandbox, sent } = harness();
  sandbox.subject.capture('page', { analytics_contract_version: 99, is_authenticated: true });
  assert.equal(sent[0].properties.$process_person_profile, false);
  assert.equal(sent[0].properties.is_authenticated, false);
  assert.equal(sent[0].properties.analytics_contract_version, 2);
  sandbox.navigator.doNotTrack = '1'; sandbox.subject.capture('page'); assert.equal(sent.length, 1);
  sandbox.navigator.doNotTrack = '0'; sandbox.subject.capture('page');
  assert.notEqual(sent[0].distinct_id, sent[1].distinct_id);
});
test('initial DNT erases the previous anonymous generation and sends nothing', () => {
  const { sandbox, sent, storage } = harness('1'); sandbox.subject.capture('page');
  assert.equal(sent.length, 0); assert.equal(storage.size, 0);
});
