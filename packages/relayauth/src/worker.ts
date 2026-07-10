// SST entrypoint for the `RelayauthApi` Cloudflare Worker (see
// `infra/relayauth.ts`). The worker's request handler and route surface
// live in `@relayauth/server`; this file only wires them up.
//
// IMPORTANT: SST decides whether to re-bundle and re-upload the worker
// by hashing the handler source. It does NOT diff `node_modules`, so a
// `@relayauth/server` dep bump alone will silently leave the deployed
// worker on an older bundled version until something in this file
// changes. When bumping `@relayauth/server`, also touch the version
// marker in this comment so SST notices a change and re-bundles with
// the new dependency:
//
//   bundled @relayauth/server: 0.2.17

export { default, IdentityDO } from "./entrypoints/cloudflare.js";
export { createApp } from "@relayauth/server";
