import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Browser workflows for every role against the running stack (docker compose up).
const env = Object.fromEntries(
  readFileSync("../../.env", "utf8")
    .split("\n")
    .filter((x) => x.includes("=") && !x.startsWith("#"))
    .map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1).replace(/^['"]|['"]$/g, "")]),
);
const API = process.env.API_URL ?? "http://localhost:4000/api";
const shot = (page: Page, name: string) => page.screenshot({ path: `../../docs/evidence/${name}.png`, fullPage: true });

/** Demo mode: pick the role in the header "View as" switcher (roles are still enforced by the API). */
async function signIn(page: Page, role: "operator" | "depot" | "station", pick?: string) {
  const value = role === "operator" ? "operator" : (pick as string);
  await page.getByLabel("View as").selectOption(value);
  await expect(page.getByText(/Now viewing as/).first()).toBeVisible();
}

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

test("guest sees live operations and is told how to act", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await expect(page.getByText("Service level")).toBeVisible();
  await expect(page.getByText("Decisions that need you")).toBeVisible();
  await expect(page.getByLabel("View as")).toBeVisible();
  await expect(page.getByText(/Autopilot (ON|OFF)/).first()).toBeVisible();
  await shot(page, "01-operations-guest");
  expect(errors).toEqual([]);
});

test("operator: decision queue, approve/reject visible, copilot answers with tools", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await page.goto("/");
  await signIn(page, "operator");
  await shot(page, "02-operations-operator");
  await page.goto("/recommendations");
  await expect(page.getByText("How decisions work.")).toBeVisible();
  await shot(page, "03-decision-queue");
  await page.goto("/assistant");
  await page.getByRole("button", { name: "What needs my attention right now, and what should I approve first?" }).click();
  await expect(page.getByText(/Agent trace \(\d+ tool calls\)/)).toBeVisible({ timeout: 90_000 });
  await shot(page, "04-ops-copilot");
  await page.goto("/control");
  await expect(page.getByText("Current posture")).toBeVisible();
  await shot(page, "05-scenario-control");
  expect(errors).toEqual([]);
});

test("station manager requests fuel; depot manager accepts it", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  // clean slate: cancel any open DIESEL request for Cox's Bazar via API
  const token = (await (await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "e2e", role: "operator", password: env.OPERATOR_PASSWORD }) })).json()).token;
  const open = (await (await fetch(`${API}/requests`, { headers: { authorization: `Bearer ${token}` } })).json()) as { id: number; stationId: string; status: string }[];
  for (const r of open.filter((x) => x.stationId === "station-coxsbazar" && x.status === "OPEN"))
    await fetch(`${API}/requests/${r.id}/cancel`, { method: "POST", headers: { authorization: `Bearer ${token}` } });

  await page.goto("/station");
  await signIn(page, "station", "station-coxsbazar");
  await expect(page).toHaveURL(/station$/);
  await page.getByLabel("Fuel").selectOption("DIESEL");
  await page.getByLabel("Quantity (L)").fill("1500");
  await page.getByLabel("Urgency").selectOption("emergency");
  await page.getByRole("button", { name: "Submit fuel request" }).click();
  await expect(page.getByText(/Request #\d+ submitted/)).toBeVisible();
  await shot(page, "06-station-portal");

  const depot = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const depotErrors = collectErrors(depot);
  await depot.goto("/depot");
  await signIn(depot, "depot", "depot-patiya");
  await expect(depot.getByText("Request inbox")).toBeVisible();
  await expect(depot.getByText(/coxsbazar wants 1,500 L DIESEL/).first()).toBeVisible();
  await shot(depot, "07-depot-console");
  await depot.getByRole("button", { name: "Accept & dispatch" }).first().click();
  await expect(depot.getByText(/Accepted by/).first()).toBeVisible();
  expect([...errors, ...depotErrors]).toEqual([]);
});

test("intelligence lab renders real model plots", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/intelligence");
  await expect(page.getByText("Forecast error by model")).toBeVisible();
  await page.getByRole("button", { name: "Run comparison" }).click();
  await expect(page.getByText("demand stress").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await shot(page, "08-intelligence-lab");
  await page.goto("/forecast");
  await page.waitForTimeout(1500);
  await shot(page, "09-risk-forecast");
  expect(errors).toEqual([]);
});

test("every page renders without client errors (desktop + mobile)", async ({ page }) => {
  const errors = collectErrors(page);
  for (const path of ["/", "/recommendations", "/assistant", "/forecast", "/disruptions", "/depot", "/station", "/intelligence", "/audit", "/health", "/control"]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByLabel("Navigate").selectOption("/recommendations");
  await expect(page).toHaveURL(/recommendations$/);
  await shot(page, "10-mobile-queue");
  expect(errors).toEqual([]);
});

test("demo guide runs the whole storyline and shows impact", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  await page.goto("/demo");
  await expect(page.getByText("Impact (live)")).toBeVisible();
  const steps = page.getByRole("button", { name: /Do it|Run again/ });
  // 1 fresh world → let autopilot run for a while
  await steps.nth(0).click();
  await expect(page.getByText("World reset and running").first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(20_000);
  // 2 spike, 3 route disruption
  await steps.nth(1).click();
  await expect(page.getByText("Demand spike scheduled for next tick").first()).toBeVisible({ timeout: 20_000 });
  await steps.nth(2).click();
  await expect(page.getByText("Route disruption scheduled").first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(12_000);
  await shot(page, "11-demo-guide-mid");
  // the operator now has anomaly decisions
  await page.goto("/recommendations");
  await expect(page.getByText(/Anomalous demand|Cross-region transfer/).first()).toBeVisible({ timeout: 20_000 });
  await shot(page, "12-queue-anomaly");
  await page.goto("/demo");
  await expect(page.getByText("Impact (live)")).toBeVisible(); // hydrated: buttons are live
  // 4 station request, 5 depot accept
  await page.getByRole("button", { name: /Do it|Run again/ }).nth(3).click();
  await expect(page.getByText(/Request #\w+ raised/).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /Do it|Run again/ }).nth(4).click();
  await expect(page.getByText(/accepted and dispatched|No open Cox/).first()).toBeVisible({ timeout: 20_000 });
  // 6 ML failure → drill banner visible for the operator → restore
  await page.getByRole("button", { name: /Do it|Run again/ }).nth(5).click();
  await expect(page.getByText(/Drill active/)).toBeVisible({ timeout: 20_000 });
  await shot(page, "13-drill-banner");
  await page.getByRole("button", { name: "Restore normal operations" }).click();
  await expect(page.getByText(/Normal operations restored/).first()).toBeVisible();
  // 7 outage → degraded → recovers
  await page.getByRole("button", { name: /Do it|Run again/ }).nth(6).click();
  await expect(page.getByText("Outage injected for 30 s").first()).toBeVisible({ timeout: 20_000 });
  await page.goto("/health");
  await expect(page.getByText(/down|degraded/).first()).toBeVisible({ timeout: 20_000 });
  await shot(page, "14-health-outage");
  await expect(page.getByText("healthy").first()).toBeVisible({ timeout: 60_000 });
  await page.goto("/demo");
  await page.waitForTimeout(3000);
  await shot(page, "15-demo-impact");
  expect(errors).toEqual([]);
});
