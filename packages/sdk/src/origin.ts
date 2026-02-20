import { SDK_VERSION } from './version.js';

export interface InternalOrigin {
  surface: string;
  client: string;
  version: string;
}

export const SDK_ORIGIN: InternalOrigin = Object.freeze({
  surface: 'sdk',
  client: '@relaycast/sdk',
  version: SDK_VERSION,
});
