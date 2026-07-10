// Phase 1 E2E walkthrough of the Launch Agent wizard. Drives the demo flow in
// a headless browser and screenshots each step to /tmp/launch-shots.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.WALK_BASE || "http://localhost:3007";
const PERSONA = "https://github.com/AgentWorkforce/agents/blob/main/review/persona.ts";
const URL = `${BASE}/cloud/deploy?persona=${encodeURIComponent(PERSONA)}`;
const OUT = "/tmp/launch-shots";
mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log("[walk]", ...a);
const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  log("screenshot", `${name}.png`);
};

async function currentTitle(page) {
  // The active step title is the CardTitle in the right pane.
  return (await page.locator("h1, [data-slot='card-title']").allInnerTexts()).join(" | ");
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

try {
  log("goto", URL);
  await page.goto(URL, { waitUntil: "networkidle" });
  // Wait for the wizard to resolve the persona (skeleton → content).
  await page.getByText("Deploy Review Agent", { exact: false }).waitFor({ timeout: 15000 });
  log("title:", await currentTitle(page));
  await shot(page, "01-review");

  const clickContinue = async () => {
    const btn = page.getByRole("button", { name: /Continue/ });
    await btn.click();
    await page.waitForTimeout(500);
  };

  // review → workspace
  await clickContinue();
  log("title:", await currentTitle(page));
  await shot(page, "02-workspace");

  // workspace → integrations
  await clickContinue();
  log("title:", await currentTitle(page));
  // connect every integration (demo simulates success)
  const connectButtons = page.getByRole("button", { name: /^Connect$/ });
  const count = await connectButtons.count();
  log("connect buttons:", count);
  for (let i = 0; i < count; i++) {
    // always click the first remaining "Connect" button
    const b = page.getByRole("button", { name: /^Connect$/ }).first();
    await b.click();
    await page.getByText("Connected").nth(i).waitFor({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(800);
  await shot(page, "03-integrations-connected");

  // integrations → model
  await clickContinue();
  log("title:", await currentTitle(page));
  await shot(page, "04-model");

  // model → inputs
  await clickContinue();
  log("title:", await currentTitle(page));
  await shot(page, "05-inputs");

  // inputs → deploy
  await clickContinue();
  log("title:", await currentTitle(page));
  await shot(page, "06-deploy-review");

  // deploy
  const deployBtn = page.getByRole("button", { name: /Deploy agent/ });
  await deployBtn.click();
  // Wait for success screen
  await page.getByText(/is live/i).waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
  await shot(page, "07-deployed-success");
  log("SUCCESS: reached deployed screen");

  log("console/page errors:", errors.length ? errors.slice(0, 10) : "none");
} catch (err) {
  log("WALK FAILED:", err.message);
  await shot(page, "99-failure");
  log("console/page errors:", errors.slice(0, 10));
  process.exitCode = 1;
} finally {
  await browser.close();
}
