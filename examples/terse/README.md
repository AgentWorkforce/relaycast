# Relaycast on Terse

This example has moved into the workspace packages. Running relaycast on
[Terse](https://docs.useterse.ai) durable actors is now
[`packages/actors-workspace`](../../packages/actors-workspace) (the `Workspace`
actor: one workspace per actor on the engine's actor adapter, including the
WebSocket lifecycle) and [`packages/actors-gateway`](../../packages/actors-gateway)
(the Node gateway that routes requests by credential, opens actor sockets for
`/v1/ws` and `/v1/node/ws`, and serves signed file URLs). Deployment steps
are in [`docs/self-hosting-durable-actors.md`](../../docs/self-hosting-durable-actors.md).
