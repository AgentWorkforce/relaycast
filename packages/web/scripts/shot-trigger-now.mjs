// Screenshot evidence for the agent-detail "Trigger now" button (operator
// manual fire). Intercepts the dashboard APIs so the states render
// deterministically against `next dev` (port 3007, dev-bypass session).
//   node scripts/shot-trigger-now.mjs
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = "/tmp/trigger-now-shots";
mkdirSync(OUT, { recursive: true });

const WORKSPACE_ID = "dev-workspace-id"; // matches the dashboard dev-bypass workspace
const AGENT_ID = "00000000-0000-0000-0000-0000000000bb";

const session = {
  authenticated: true,
  user: { id: "user-1", email: "dev@localhost", name: "Dev User", avatarUrl: null },
  currentWorkspace: { id: WORKSPACE_ID, slug: "dev", name: "Dev Workspace", organization_id: "org-1" },
  workspaces: [{ id: WORKSPACE_ID, slug: "dev", name: "Dev Workspace", organization_id: "org-1" }],
};

const agent = {
  agentId: AGENT_ID,
  personaId: "persona-1",
  deployedName: "hn-monitor",
  personaDescription: "Watches Hacker News and posts a digest to Slack.",
  status: "active",
  createdAt: "2026-06-03T22:00:00.000Z",
  lastUsedAt: null,
  lastFiredAt: "2026-06-04T09:00:05.000Z",
  lastCompletedAt: "2026-06-04T09:01:10.000Z",
  runCount: 2,
  scheduleIds: ["weekly"],
  inputValues: { SLACK_CHANNEL: "#general" },
  deployedByUserId: "user-1",
};

const runs = [
  {
    id: "run-1",
    deploymentId: "dep-1",
    agentId: AGENT_ID,
    eventSource: "cron:weekly",
    sandboxId: "sbx-1",
    sandboxName: "hn-monitor-fire",
    stdoutTruncated: false,
    stderrTruncated: false,
    exitCode: 0,
    cleanupStatus: {},
    startedAt: "2026-06-04T09:00:05.000Z",
    endedAt: "2026-06-04T09:01:10.000Z",
    durationMs: 65_000,
    status: "succeeded",
    error: null,
    summary: "Posted 5 stories to #general",
    compressedAt: null,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 150,
  },
];

const b = await chromium.launch();
const errors = [];
const page = await b.newPage({ viewport: { width: 1440, height: 1100 } });
page.on("pageerror", (e) => errors.push(String(e)));
page.on("request", (r) => { if (r.url().includes("/cloud/api/")) console.log("[req]", r.method(), r.url().slice(0, 120)); });

await page.route("**/cloud/api/auth/session**", (route) =>
  route.fulfill({ json: session }),
);
await page.route(`**/cloud/api/v1/workspaces/${WORKSPACE_ID}/deployments**`, (route) =>
  route.fulfill({ json: { agents: [agent], nextCursor: null } }),
);
await page.route("**/cloud/api/v1/workflows**", (route) => route.fulfill({ json: { runs: [], schedules: [] } }));
await page.route("**/cloud/api/v1/agents/**/runs**", (route) =>
  route.fulfill({ json: { runs, totalTokens: 150 } }),
);
await page.route("**/cloud/api/v1/agents/**/runs/run-1**", (route) =>
  route.fulfill({
    json: {
      run: {
        ...runs[0],
        stdout: '{"t":"2026-06-04T09:00:06.000Z","level":"info","message":"runner.started"}',
        stderr: "",
        mountLogTail: "",
        entries: [],
      },
    },
  }),
);
// Trigger POST: delay so the in-flight "Triggering…" state is capturable.
await page.route(`**/cloud/api/v1/workspaces/${WORKSPACE_ID}/deployments/${AGENT_ID}/trigger`, async (route) => {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await route.fulfill({
    status: 202,
    json: { agentId: AGENT_ID, workspaceId: WORKSPACE_ID, deploymentId: "dep-manual-1", status: "starting" },
  });
});
// Anything else under /cloud/api: empty-ok so the dashboard provider settles.
await page.route("**/cloud/api/**", (route) => {
  if (route.request().url().includes("/auth/session") || route.request().url().includes("/deployments") || route.request().url().includes("/runs") || route.request().url().includes("/workflows")) {
    return route.fallback();
  }
  return route.fulfill({ json: {} });
});

await page.goto(`http://localhost:3007/cloud/dashboard/workforce/agents/${AGENT_ID}`, {
  waitUntil: "domcontentloaded",
  timeout: 120_000,
});
await page.waitForTimeout(4000);

async function shot(name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log(`[shot] ${name}`);
}

const triggerButton = page.getByRole("button", { name: /Trigger now/ });
try {
  await triggerButton.waitFor({ state: "visible", timeout: 15_000 });
} catch (err) {
  await page.screenshot({ path: `${OUT}/debug-failure.png`, fullPage: true });
  const body = await page.locator("body").innerText().catch(() => "");
  console.log("[debug] body excerpt:", body.slice(0, 600).replace(/\n+/g, " | "));
  throw err;
}
await shot("1-idle-trigger-now");

await triggerButton.click();
await page.getByRole("button", { name: /Confirm fire\?/ }).waitFor({ state: "visible" });
await shot("2-armed-confirm");

await page.getByRole("button", { name: /Confirm fire\?/ }).click();
await page.getByRole("button", { name: /Triggering…/ }).waitFor({ state: "visible" });
await shot("3-in-flight-triggering");

await page.getByRole("button", { name: /Fired — run incoming/ }).waitFor({ state: "visible", timeout: 10_000 });
await shot("4-fired-with-helper-text");

const body = await page.locator("body").innerText().catch(() => "");
console.log(
  `[shot] checks: helperText=${body.includes("appears in Recent fires")} ` +
    `button=${body.includes("Fired — run incoming")} overlay=${body.includes("Build Error")}`,
);
console.log("[shot] pageerrors:", errors.length ? errors.slice(0, 5) : "none");
await b.close();
