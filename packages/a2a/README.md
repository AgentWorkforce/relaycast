# `@relaycast/a2a`

Canonical A2A card and JSON-RPC schemas shared by Relaycast, Cloud, Night CTO,
and other agent-to-agent integrations.

```ts
import {
  A2aAgentCardSchema,
  type A2aAgentCard,
  type A2aSkill,
} from '@relaycast/a2a';

const card: A2aAgentCard = A2aAgentCardSchema.parse(candidate);
```

The package models HTTP wire data, so multi-word fields use `snake_case`. It
has no dependency on `@relaycast/engine` and can be imported by clients that do
not run a Relaycast gateway.
