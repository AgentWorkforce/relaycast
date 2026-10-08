import { lookup } from 'node:dns';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import { isGlobalIpAddress, isSafeExternalUrl } from '../../lib/ssrf.js';

const dispatcher = new Agent({
  connect: {
    // This callback is the connection's DNS lookup, not a preflight lookup.
    // Undici therefore opens the socket to the exact address classified here
    // while preserving the URL hostname for Host/SNI/TLS verification.
    lookup(hostname, options, callback) {
      lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
        if (error) {
          callback(error, '', 0);
          return;
        }
        const unsafe = addresses.find((entry) => !isGlobalIpAddress(entry.address));
        if (unsafe || addresses.length === 0) {
          const rejection = Object.assign(
            new Error(`Outbound webhook DNS resolved to a non-global address for ${hostname}`),
            { code: 'ENOTFOUND' },
          );
          callback(rejection, '', 0);
          return;
        }
        if (options.all) {
          callback(null, addresses);
        } else {
          callback(null, addresses[0].address, addresses[0].family);
        }
      });
    },
  },
});

/** HTTPS-only fetch whose connector validates and pins DNS answers at connect time. */
export const nodeSafeWebhookFetch: typeof globalThis.fetch = async (input, init) => {
  const rawUrl = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  if (!isSafeExternalUrl(rawUrl, { strict: true, requireHttps: true })) {
    throw new Error('Unsafe outbound webhook URL');
  }
  return undiciFetch(rawUrl, {
    ...(init as UndiciRequestInit),
    redirect: 'manual',
    dispatcher,
  }) as unknown as Response;
};
