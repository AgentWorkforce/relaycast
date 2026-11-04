# Security Policy

Relaycast is part of Agent Relay. It handles credentials, tokens and agent
session data, so we treat security reports as a priority over feature work.

## Reporting a vulnerability

Please report vulnerabilities privately. Do not open a public issue, pull
request or discussion for a security problem.

- **GitHub private vulnerability reporting (preferred):**
  https://github.com/AgentWorkforce/relaycast/security/advisories/new
- **Email:** security@agentrelay.com

Please include:

- the affected component, version, image digest or commit;
- the type of issue (for example authentication bypass, credential disclosure,
  injection, privilege escalation, or denial of service);
- steps to reproduce, ideally a minimal configuration or script;
- the impact: what an attacker gains and what access they need to start.

**Redact credentials before you send them.** Replace tokens, API keys and
connection strings with placeholders. If a report needs a live credential to
demonstrate, tell us and we will arrange a private channel for it.

## What to expect

- **Acknowledgement:** within 3 business days.
- **Assessment:** we aim to confirm or dispute the report, with a severity
  assessment, within 10 business days.
- **Updates:** we will tell you how remediation is going, and if a fix will take
  longer than expected.
- **Disclosure:** we publish an advisory once a fixed release is available and
  credit you by name or handle unless you prefer otherwise.

Please give us a reasonable opportunity to ship a fix before you disclose
publicly. We do not run a paid bug bounty.

## Supported versions

Fixes ship in the latest release (and, for container images, the next image
published from `main`). We do not backport fixes to older releases; upgrade to
the latest release to receive them.

## Scope

In scope: the code in this repository and the artifacts built from it
(the `@relaycast/*` npm packages, the `relaycast` CLI and the `relaycast-self-host` and `relaycast-actors-*` container images).

Out of scope: vulnerabilities in third-party dependencies with no demonstrated
exploit path through this project, findings that need an attacker to already
control the host or cluster running the service, and unvalidated reports from
automated scanners.
