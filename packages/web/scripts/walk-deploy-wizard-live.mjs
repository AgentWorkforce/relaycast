#!/usr/bin/env node
// Live-mode walkthrough of the Launch Agent wizard. This intentionally keeps
// OAuth/model-credential steps human-assisted: headless mode proves live
// resolve, while headed mode can wait for an operator to complete live-only
// steps and then dry-run or perform the final deploy POST.

import { mkdirSync } from "node:fs";

const HELP = process.argv.includes("--help") || process.argv.includes("-h");

if (HELP) {
  console.log(`
Usage:
  node packages/web/scripts/walk-deploy-wizard-live.mjs

Environment:
  WALK_BASE=http://localhost:3007
  WALK_PERSONA=https://github.com/AgentWorkforce/agents/blob/main/review/persona.ts
  WALK_OUT=/tmp/launch-live-shots
  WALK_HEADLESS=1              # set 0 for human OAuth/provider credential steps
  WALK_REAL_DEPLOY=0           # set 1 to let the real deployments POST through
  WALK_HUMAN_TIMEOUT_MS=120000 # headed wait budget per human-only step

Default behavior:
  - Opens /cloud/deploy?live=1 with the real persona URL.
  - Asserts live resolve by requiring no demo fallback banner and no demo-preview text.
  - Walks until a live-only OAuth/provider-credential step needs a human.
  - In headed mode, waits for the operator to make Continue/Deploy available.
  - In dry-run mode, intercepts model-credential and final deployment POSTs,
    validates their payloads, and returns fake success responses so no real
    credential or agent is created.
`);
  process.exit(0);
}

const { chromium } = await importPlaywright();

const BASE = process.env.WALK_BASE || "http://localhost:3007";
const PERSONA =
  process.env.WALK_PERSONA ||
  "https://github.com/AgentWorkforce/agents/blob/main/review/persona.ts";
const URL = `${BASE}/cloud/deploy?live=1&persona=${encodeURIComponent(PERSONA)}`;
const OUT = process.env.WALK_OUT || "/tmp/launch-live-shots";
const HEADLESS = process.env.WALK_HEADLESS !== "0";
const REAL_DEPLOY = process.env.WALK_REAL_DEPLOY === "1";
const HUMAN_TIMEOUT_MS = readPositiveIntegerEnv("WALK_HUMAN_TIMEOUT_MS", 120_000);

mkdirSync(OUT, { recursive: true });

const log = (...args) => console.log("[live-walk]", ...args);
const summary = {
  liveResolve: false,
  reachedDeployStep: false,
  deployPostObserved: false,
  modelCredentialPostObserved: false,
  humanRequired: [],
  dryRun: !REAL_DEPLOY,
};

const browser = await chromium.launch({ headless: HEADLESS });
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
const errors = [];
page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
page.on("pageerror", (error) => errors.push(String(error)));

if (!REAL_DEPLOY) {
  await page.route("**/api/v1/workspaces/*/provider-credentials/**", async (route, request) => {
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }

    const payload = request.postDataJSON();
    const modelProvider = assertModelCredentialPayload(payload);
    summary.modelCredentialPostObserved = true;
    log(`dry-run model credential POST observed for ${modelProvider}; returning fake credential id`);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        providerCredentialId: `dry-run-${modelProvider}-credential-live-walk`,
        id: `dry-run-${modelProvider}-credential-live-walk`,
      }),
    });
  });

  await page.route("**/api/v1/workspaces/*/deployments", async (route, request) => {
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }

    const payload = request.postDataJSON();
    assertDeployPayload(payload);
    summary.deployPostObserved = true;
    log("dry-run deployments POST observed; payload has persona, bundle, inputs, credentialSelections");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        agentId: "dry-run-agent-live-walk",
        deploymentId: "dry-run-deployment-live-walk",
        status: "ready",
      }),
    });
  });
}

try {
  log("goto", URL);
  await page.goto(URL, { waitUntil: "networkidle", timeout: 30_000 });
  await page.getByText("Launch Agent", { exact: false }).waitFor({ timeout: 30_000 });
  await waitForWizardResolved(page);
  await assertLiveResolve(page);
  summary.liveResolve = true;
  log("live resolve ok:", await headingText(page));
  await shot(page, "01-live-review");

  await continueWhenReady(page, "review");
  log("workspace step:", await activeStepText(page));
  await shot(page, "02-workspace");

  await continueWhenReady(page, "workspace");
  await walkMiddleSteps(page);

  if (summary.reachedDeployStep) {
    await shot(page, "06-deploy-review");
    await clickDeployWhenReady(page);
    await page.getByText(/is live|Previewed/i).waitFor({ timeout: 30_000 });
    await shot(page, "07-deploy-result");
    if (!REAL_DEPLOY && !summary.deployPostObserved) {
      throw new Error("Expected dry-run deployments POST was not observed.");
    }
  }

  log("summary:", JSON.stringify(summary, null, 2));
  log("console/page errors:", errors.length ? errors.slice(0, 10) : "none");
} catch (error) {
  log("WALK FAILED:", error instanceof Error ? error.message : String(error));
  await shot(page, "99-failure").catch(() => undefined);
  log("summary:", JSON.stringify(summary, null, 2));
  log("console/page errors:", errors.slice(0, 10));
  process.exitCode = 1;
} finally {
  await browser.close();
}

async function walkMiddleSteps(page) {
  for (let guard = 0; guard < 8; guard += 1) {
    const text = await activeStepText(page);
    log("active step:", text);
    if (/Deploy agent|Ready to launch|Review deployment/i.test(text)) {
      summary.reachedDeployStep = true;
      return;
    }

    if (/Connect integrations|integration/i.test(text)) {
      await shot(page, "03-integrations");
      await handleHumanOnlyStep(page, "integrations", "Complete real Nango OAuth connections, then press Continue.");
      if (HEADLESS) return;
      continue;
    }

    if (/Connect model|model/i.test(text)) {
      await shot(page, "04-model");
      await handleHumanOnlyStep(page, "model", "Choose plan or enter BYOK credentials, then press Continue.");
      if (HEADLESS) return;
      continue;
    }

    if (/Agent inputs|inputs/i.test(text)) {
      await shot(page, "05-inputs");
      const ready = await handleInputs(page);
      if (!ready) return;
      await continueWhenReady(page, "inputs");
      continue;
    }

    await continueWhenReady(page, "step");
  }

  throw new Error("Wizard did not reach deploy step within guard limit.");
}

async function handleHumanOnlyStep(page, stepName, instruction) {
  summary.humanRequired.push({ step: stepName, instruction });
  if (HEADLESS) {
    log(`HUMAN REQUIRED (${stepName}): ${instruction}`);
    log("Headless mode stops here after proving live resolve. Re-run with WALK_HEADLESS=0 for the assisted full walk.");
    return;
  }

  log(`HUMAN REQUIRED (${stepName}): ${instruction}`);
  await waitForContinueEnabled(page, HUMAN_TIMEOUT_MS);
  await continueWhenReady(page, stepName);
}

async function handleInputs(page) {
  const button = page.getByRole("button", { name: /^Continue$/ });
  await button.waitFor({ timeout: 15_000 });
  if (await button.isEnabled()) {
    return true;
  }

  const instruction = "Fill required live picker/input values with real ids.";
  summary.humanRequired.push({ step: "inputs", instruction });
  if (HEADLESS) {
    log(`HUMAN REQUIRED (inputs): ${instruction}`);
    log("Headless mode stops here after proving live resolve. Re-run with WALK_HEADLESS=0 for the assisted full walk.");
    return false;
  }

  log(`HUMAN REQUIRED (inputs): ${instruction} Then press Continue.`);
  await waitForContinueEnabled(page, HUMAN_TIMEOUT_MS);
  return true;
}

async function clickDeployWhenReady(page) {
  const deploy = page.getByRole("button", { name: /Deploy agent/ });
  if (HEADLESS) {
    await expectEnabled(deploy, "Deploy agent");
  } else {
    await deploy.waitFor({ timeout: HUMAN_TIMEOUT_MS });
    await waitForButtonEnabled(deploy, HUMAN_TIMEOUT_MS, "Deploy agent");
  }
  await deploy.click();
}

async function continueWhenReady(page, label) {
  const button = page.getByRole("button", { name: /^Continue$/ });
  await expectEnabled(button, `Continue (${label})`);
  await button.click();
  await page.waitForTimeout(500);
}

async function waitForContinueEnabled(page, timeoutMs) {
  const button = page.getByRole("button", { name: /^Continue$/ });
  await button.waitFor({ timeout: timeoutMs });
  await waitForButtonEnabled(button, timeoutMs, "Continue");
}

async function waitForButtonEnabled(locator, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await locator.isEnabled()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become enabled within ${timeoutMs}ms.`);
}

async function expectEnabled(locator, label) {
  await locator.waitFor({ timeout: 15_000 });
  if (!(await locator.isEnabled())) {
    throw new Error(`${label} is disabled. This is usually a live-only human step.`);
  }
}

async function waitForWizardResolved(page) {
  await page
    .locator("[data-slot='skeleton']")
    .first()
    .waitFor({ state: "detached", timeout: 30_000 })
    .catch(() => undefined);
  await page.locator("h1").filter({ hasText: /Deploy / }).waitFor({ timeout: 30_000 });
}

async function assertLiveResolve(page) {
  const body = await page.locator("body").innerText();
  if (/Showing demo data/i.test(body) || /Demo preview/i.test(body)) {
    throw new Error("Live resolve fell back to demo data.");
  }
  if (!/Deploy /.test(await headingText(page))) {
    throw new Error("Wizard did not render a resolved persona heading.");
  }
}

async function activeStepText(page) {
  return (await page.locator("[data-slot='card-title']").allInnerTexts()).join(" | ");
}

async function headingText(page) {
  return (await page.locator("h1").allInnerTexts()).join(" | ");
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  log("screenshot", `${name}.png`);
}

function assertDeployPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Deploy payload must be an object.");
  }
  if (!payload.bundle || typeof payload.bundle !== "object") {
    throw new Error("Deploy payload missing bundle.");
  }
  for (const key of ["runner", "agent"]) {
    if (typeof payload.bundle[key] !== "string" || !payload.bundle[key]) {
      throw new Error(`Deploy bundle missing ${key}.`);
    }
  }
  if (!payload.bundle.packageJson || typeof payload.bundle.packageJson !== "object") {
    throw new Error("Deploy bundle missing packageJson.");
  }
  if (!payload.persona || typeof payload.persona !== "object") {
    throw new Error("Deploy payload missing persona.");
  }
  if (!payload.inputs || typeof payload.inputs !== "object") {
    throw new Error("Deploy payload missing inputs.");
  }
  if (!payload.credentialSelections || typeof payload.credentialSelections !== "object") {
    throw new Error("Deploy payload missing credentialSelections.");
  }
}

function assertModelCredentialPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Model credential payload must be an object.");
  }
  if (typeof payload.modelProvider !== "string" || !payload.modelProvider.trim()) {
    throw new Error("Model credential payload missing modelProvider.");
  }
  if ("key" in payload && typeof payload.key !== "string") {
    throw new Error("BYOK model credential payload key must be a string.");
  }
  return payload.modelProvider.trim();
}

function readPositiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

async function importPlaywright() {
  try {
    return await import("playwright");
  } catch {
    console.error("[live-walk] playwright is not installed. Install/provide Playwright to run this browser harness.");
    console.error("[live-walk] This repo already has a demo walker with the same dependency: packages/web/scripts/walk-deploy-wizard.mjs");
    process.exit(1);
  }
}
