// @ts-check
import { test, expect } from "@playwright/test";
import simulateFixture from "./fixtures/simulate-response.json" with { type: "json" };

test.describe("Simulate charts", () => {
  test("renders P&L histogram and diverging theta chart from simulate payload", async ({ page }) => {
    await page.goto("/");

    await page.evaluate((data) => {
      // @ts-expect-error classic globals
      state.simDone = true;
      // @ts-expect-error classic globals
      state.simResult = data;
      // @ts-expect-error classic globals
      renderSimResults(data);
      // @ts-expect-error classic globals
      switchToTab("simulate", { scrollTop: true });
    }, simulateFixture);

    await expect(page.locator("#tab-simulate")).toBeVisible();

    const pnlCanvas = page.locator("#chart-portfolio");
    await expect(pnlCanvas).toBeVisible();
    const pnlBox = await pnlCanvas.boundingBox();
    expect(pnlBox?.width).toBeGreaterThan(50);
    expect(pnlBox?.height).toBeGreaterThan(50);

    const thetaSection = page.locator("#theta-section");
    await expect(thetaSection).toBeVisible();

    const thetaCanvas = page.locator("#chart-theta-daily");
    await expect(thetaCanvas).toBeVisible();
    const thetaBox = await thetaCanvas.boundingBox();
    expect(thetaBox?.width).toBeGreaterThan(50);
    expect(thetaBox?.height).toBeGreaterThan(50);

    await expect(page.locator("#theta-subtitle")).not.toBeEmpty();
  });

  test("mocked /api/simulate returns fixture and drives UI", async ({ page }) => {
    await page.route("**/api/simulate", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(simulateFixture),
      });
    });
    await page.route("**/api/desk-alerts", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ alerts: [] }),
      });
    });

    await page.goto("/");

    await page.evaluate((pos) => {
      // @ts-expect-error classic globals
      state.positions = [pos];
      // @ts-expect-error classic globals
      state.marketData = { DEMO: { price: 100, iv: 40 } };
      // @ts-expect-error classic globals
      if (typeof enableSimButton === "function") enableSimButton();
    }, {
      ticker: "DEMO",
      posType: "option",
      optType: "Put",
      strike: 95,
      expiry: new Date("2026-06-20"),
      contracts: -2,
      avgCost: 1.25,
    });

    const inline = page.locator("#btn-simulate-inline");
    await expect(inline).toBeVisible();
    await inline.click();

    await expect(page.locator("#theta-section")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#chart-portfolio")).toBeVisible();
  });

  test("serves vendored Chart.js (not CDN)", async ({ page }) => {
    const res = await page.request.get("/static/vendor/chart.js/4.4.1/chart.umd.min.js");
    expect(res.ok()).toBeTruthy();
    const body = await res.text();
    expect(body).toContain("Chart");
  });
});
