# Communication policy

Relaycast owns Open, Knock, Allow list, Busy, and Offline interpretation; admission decisions; grants; receipts; and the delivery coordinator. No work states or PR completion rules live here.

The root export contains pure schemas and decisions. `./service` provides the storage-independent coordinator. A storage adapter must serialize recipient changes with final injection and atomically commit each callback. Cloud supplies a PostgreSQL adapter; Relaycast engine adapters and direct transport coverage are required before enrollment can be enabled.

Contract JSON is an internal cross-language artifact, not a new HTTP endpoint. Existing Relaycast HTTP APIs remain snake_case. `npm run contracts:check` verifies generated schemas and fixtures; `npm test` checks decisions. No transport is enrolled by installing this package.
