import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  findTeamSpecFromPersonaDir,
  loadTeamSpec,
  loadTeamSpecFile,
  loadTeamSpecFromPersonaDir,
  parseTeamSpecFile,
  TeamSpecError,
} from "../src/proactive-runtime/team-spec.js";

test("loadTeamSpec accepts a first-class team binding with heterogeneous members", () => {
  const spec = loadTeamSpec({
    id: "linear-agent",
    lead: "chat-lead",
    tokenBudget: 250000,
    timeBudgetSeconds: 1800,
    members: [
      {
        name: "chat-lead",
        persona: { path: "agents/linear", version: "latest" },
        role: "lead",
        owns: [
          { provider: "linear", on: "AgentSessionEvent.created" },
          { provider: "linear", on: "AgentSessionEvent.prompted" },
        ],
      },
      {
        name: "implementer",
        persona: "cloud-small-issue-codex@latest",
        role: "implementer",
      },
    ],
    delegation: [{ intent: "implement", to: "implementer" }],
  });

  assert.deepEqual(spec, {
    id: "linear-agent",
    lead: "chat-lead",
    tokenBudget: 250000,
    timeBudgetSeconds: 1800,
    members: [
      {
        name: "chat-lead",
        persona: { path: "agents/linear", version: "latest" },
        role: "lead",
        owns: [
          { provider: "linear", on: "AgentSessionEvent.created" },
          { provider: "linear", on: "AgentSessionEvent.prompted" },
        ],
      },
      {
        name: "implementer",
        persona: "cloud-small-issue-codex@latest",
        role: "implementer",
      },
    ],
    delegation: [{ intent: "implement", to: "implementer" }],
  });
});

test("loadTeamSpec accepts a standing lead outside the launchable members", () => {
  const spec = loadTeamSpec({
    id: "cloud-team-issue",
    lead: "cloud-team-issue",
    members: [
      {
        name: "cloud-team-issue-n1",
        persona: { slug: "cloud-team-issue" },
        role: "implementer",
      },
    ],
  });

  assert.deepEqual(spec, {
    id: "cloud-team-issue",
    lead: "cloud-team-issue",
    members: [
      {
        name: "cloud-team-issue-n1",
        persona: { slug: "cloud-team-issue" },
        role: "implementer",
      },
    ],
  });
});

test("loadTeamSpec normalizes persona version strings", () => {
  const spec = loadTeamSpec({
    id: "team",
    lead: "lead",
    members: [{ name: "lead", persona: { path: "agents/linear", version: " latest " } }],
  });

  assert.deepEqual(spec.members[0]?.persona, {
    path: "agents/linear",
    version: "latest",
  });
});

test("loadTeamSpec enforces unique member names", () => {
  assert.throws(
    () =>
      loadTeamSpec({
        id: "team",
        lead: "lead",
        members: [
          { name: "lead", persona: "lead-persona" },
          { name: "lead", persona: "other-persona" },
        ],
      }),
    /duplicate member name "lead"/,
  );
});

test("loadTeamSpec validates persona refs, owns, delegation, and budgets", () => {
  assert.throws(
    () =>
      loadTeamSpec({
        id: "team",
        lead: "lead",
        members: [{ name: "lead", persona: { version: 1 } }],
      }),
    /members\[0\]\.persona must include slug, path, or inline/,
  );

  assert.throws(
    () =>
      loadTeamSpec({
        id: "team",
        lead: "lead",
        members: [{ name: "lead", persona: "lead", owns: ["linear"] }],
      }),
    /members\[0\]\.owns\[0\] must be an object/,
  );

  assert.throws(
    () =>
      loadTeamSpec({
        id: "team",
        lead: "lead",
        members: [{ name: "lead", persona: "lead" }],
        delegation: { intent: "implement" },
      }),
    /delegation must be an array/,
  );

  assert.throws(
    () =>
      loadTeamSpec({
        id: "team",
        lead: "lead",
        members: [{ name: "lead", persona: "lead" }],
        tokenBudget: 0,
      }),
    /tokenBudget must be a positive 32-bit integer/,
  );

  assert.throws(
    () =>
      loadTeamSpec({
        id: "team",
        lead: "lead",
        members: [{ name: "lead", persona: "lead" }],
        timeBudgetSeconds: 2_147_483_648,
      }),
    /timeBudgetSeconds must be a positive 32-bit integer/,
  );
});

test("loadTeamSpec rejects duplicate owned trigger selectors across members", () => {
  assert.throws(
    () =>
      loadTeamSpec({
        id: "team",
        lead: "lead",
        members: [
          {
            name: "lead",
            persona: "lead-persona",
            owns: [{ on: "issue.created", provider: "linear" }],
          },
          {
            name: "impl",
            persona: "impl-persona",
            owns: [{ provider: "linear", on: "issue.created" }],
          },
        ],
      }),
    /owns selector .* is claimed by both "lead" and "impl"/,
  );
});

test("loadTeamSpec allows duplicate owned selectors within one member", () => {
  const spec = loadTeamSpec({
    id: "team",
    lead: "lead",
    members: [
      {
        name: "lead",
        persona: "lead-persona",
        owns: [
          { provider: "linear", on: "issue.created" },
          { on: "issue.created", provider: "linear" },
        ],
      },
    ],
  });

  assert.equal(spec.members[0]?.name, "lead");
});

test("loadTeamSpec throws TeamSpecError on invalid specs", () => {
  assert.throws(() => loadTeamSpec(null), TeamSpecError);
});

test("loadTeamSpec rejects sparse arrays with TeamSpecError", () => {
  const sparseMembers = new Array(1);
  assert.throws(
    () =>
      loadTeamSpec({
        id: "team",
        lead: "lead",
        members: sparseMembers,
      }),
    (error: unknown) =>
      error instanceof TeamSpecError &&
      /members\[0\] must be an object/.test(error.message),
  );

  const sparseOwns = new Array(1);
  assert.throws(
    () =>
      loadTeamSpec({
        id: "team",
        lead: "lead",
        members: [{ name: "lead", persona: "lead-persona", owns: sparseOwns }],
      }),
    (error: unknown) =>
      error instanceof TeamSpecError &&
      /members\[0\]\.owns\[0\] must be an object/.test(error.message),
  );
});

test("loadTeamSpecFromPersonaDir reads team.json from a persona directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cloud-team-spec-"));
  try {
    await writeFile(
      join(dir, "team.json"),
      JSON.stringify({
        id: "cloud-issue-team",
        lead: "lead",
        members: [
          { name: "lead", persona: { path: "personas/cloud-team-issue" }, role: "lead" },
          { name: "impl", persona: "cloud-small-issue-codex@latest" },
        ],
      }),
      "utf8",
    );

    const spec = await loadTeamSpecFromPersonaDir(dir);

    assert.equal(spec.id, "cloud-issue-team");
    assert.equal(spec.lead, "lead");
    assert.deepEqual(spec.members.map((member) => member.name), ["lead", "impl"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findTeamSpecFromPersonaDir is null when legacy persona dirs omit team.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cloud-team-spec-"));
  try {
    assert.equal(await findTeamSpecFromPersonaDir(dir), null);
    await assert.rejects(
      () => loadTeamSpecFromPersonaDir(dir),
      /No team\.json found in persona directory/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("team spec file loaders include source context for invalid JSON and specs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cloud-team-spec-"));
  try {
    const jsonPath = join(dir, "invalid-json.json");
    await writeFile(jsonPath, "{", "utf8");
    await assert.rejects(
      () => loadTeamSpecFile(jsonPath),
      /Invalid JSON in .*invalid-json\.json/,
    );

    const specPath = join(dir, "team.json");
    await writeFile(specPath, JSON.stringify({ id: "team", lead: "lead", members: [] }), "utf8");
    await assert.rejects(
      () => loadTeamSpecFromPersonaDir(dir),
      /Invalid team spec in .*team\.json: members must be a non-empty array/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseTeamSpecFile requires id to match the team directory name", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-team-spec-"));
  try {
    const teamDir = join(root, "teams", "cloud-team-issue");
    await mkdir(teamDir, { recursive: true });
    const specPath = join(teamDir, "team.json");
    await writeFile(
      specPath,
      JSON.stringify({
        id: "other-team",
        lead: "lead",
        members: [{ name: "lead", persona: "lead-persona" }],
      }),
      "utf8",
    );

    await assert.rejects(
      () => parseTeamSpecFile(specPath),
      /TeamSpec id "other-team" must match team directory "cloud-team-issue"/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
