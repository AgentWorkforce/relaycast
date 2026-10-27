# Muse and Devin CLI type alignment

- Task: align shared spawn validation, SDK types, MCP, and API documentation with native Muse/Devin support; retain OpenCode/Grok and existing CLI behavior.
- Decision: extend the shared Zod enum so API and MCP consumers inherit support. Keep the native action route's capability-driven dispatch unchanged.
- Additional finding: Rust registration's independent allowlist silently falls back for OpenCode, Grok, Muse, and Devin. Add those names without changing existing normalization or fallback semantics.
- Coverage: schema acceptance/rejection and OpenAPI parity, SDK compile-time union checks, HTTP dispatch for all nine CLIs, MCP forwarding/rejection, and Rust registration hints/defaults.
- Local verification: TypeScript syntax, enum/OpenAPI parity, Rust allowlist coverage, and whitespace checks passed. Runtime/typechecking and Rust tests require CI: dependencies and Rust tools are absent. No installs, Docker, or local builds were used.
- Audit: site tool badges/animation and fleet-wire sample fixtures are illustrative, not rejecting allowlists; left unchanged.
- Tooling: Trail is unavailable globally and locally. This manual compact record preserves the trajectory without installing packages.
