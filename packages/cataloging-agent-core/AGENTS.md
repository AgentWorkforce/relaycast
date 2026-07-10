# cataloging-agent-core (and the cataloging-agent-* family)

`@cloud/cataloging-agent-core` is the shared runtime for every
`packages/cataloging-agent-*` package (currently `cataloging-agent-github`
and `cataloging-agent-linear`, more to follow). A cataloging agent watches a
relayfile workspace, reads the structured entries written there by the
adapter ingest pipeline, and produces synthesized "insights" — model-authored
summaries, status rollups, attention surfaces — that get written back into
relayfile or surfaced through the cataloging API.

The architectural boundary that holds the family together is **cataloging
agents are pure relayfile consumers**. They read `_index.json`, parse
per-entry JSON via `@relayfile/sdk`, and call LLM endpoints (OpenRouter,
Anthropic, OpenAI) for synthesis. They never call source-of-truth SaaS APIs
(`api.github.com`, `api.linear.app`, `api.notion.com`, …) directly, and they
never import vendor SDKs (`@octokit/*`, `@linear/sdk`, …). All third-party
API access — fetching, path mapping, webhook normalization, writeback — lives
in `relayfile-adapters/packages/<integration>/src/`. If a cataloging insight
needs data that isn't in the relayfile mount yet, the right fix is upstream
in the adapter (adapter sync, lazy materialization, webhook coverage), not a
sidecar fetch from cataloging.

This boundary is the enforceable contract — see
`.claude/rules/cataloging-agent-no-third-party-apis.md` for the path-scoped
rule that fires on every file under `packages/cataloging-agent-*`. We learned
this the hard way in cloud#499 (a 380-line GitHub materializer landed inside
`cataloging-agent-github` that duplicated `relayfile-adapters`'s
`materializeRepo`, was wired only to its own test, and called
`api.github.com/graphql` from a Worker). The cleanup in cloud#501 deleted
that file and codified the rule. Do not bring it back.
