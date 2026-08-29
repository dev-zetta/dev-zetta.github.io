import { readFile } from "node:fs/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const snapshot = JSON.parse(
  await readFile("src/data/portfolio.generated.json", "utf8"),
);

test("renders the complete portfolio and metadata", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Gabriel Max/);
  await expect(page.locator("link[rel='canonical']")).toHaveAttribute(
    "href",
    "https://dev-zetta.github.io/",
  );
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Engineering reliable software",
  );
  await expect(page.locator(".featured-grid [data-project-card]")).toHaveCount(
    6,
  );
  await expect(
    page.locator("[data-project-grid] [data-project-card]"),
  ).toHaveCount(snapshot.repositories.length);
  await expect(page.locator("footer")).toContainText(
    /Portfolio v\d+\.\d+\.\d+/,
  );
});

test("searches, filters, clears, and exposes an empty result", async ({
  page,
}) => {
  await page.goto("/#projects");
  const cards = page.locator("[data-project-grid] [data-project-card]:visible");

  await page.getByLabel("Relationship").selectOption("fork");
  await expect(cards).toHaveCount(4);
  await page.getByLabel("Search repositories").fill("sacd");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("sacd_extract2");

  await page
    .getByLabel("Search repositories")
    .fill("no-project-can-match-this");
  await expect(cards).toHaveCount(0);
  await expect(page.locator("[data-empty-state]")).toBeVisible();

  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(cards).toHaveCount(snapshot.repositories.length);
});

test("persists the selected color theme", async ({ page }) => {
  await page.goto("/");
  const before = await page.locator("html").getAttribute("data-theme");
  const toggle = page.getByRole("button", { name: /Switch to .* theme/ });
  await toggle.focus();
  await page.keyboard.press("Enter");
  const after = await page.locator("html").getAttribute("data-theme");
  expect(after).not.toBe(before);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    String(after),
  );
});

test("has no serious automated accessibility violations", async ({ page }) => {
  await page.goto("/");
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    );
    expect(serious, `${theme} theme`).toEqual([]);
  }
});

test("keeps internal navigation targets valid", async ({ page }) => {
  await page.goto("/");
  const targets = await page
    .locator("a[href^='#']")
    .evaluateAll((links) =>
      links.map((link) => link.getAttribute("href")).filter(Boolean),
    );
  for (const target of new Set(targets)) {
    expect(await page.locator(String(target)).count()).toBeGreaterThan(0);
  }
});

test("respects reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const duration = await page
    .locator(".project-card")
    .first()
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.001);
});

test("remains readable without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(
    page.locator("[data-project-grid] [data-project-card]"),
  ).toHaveCount(snapshot.repositories.length);
  await context.close();
});

test("does not overflow the mobile viewport", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "mobile-only assertion");
  await page.goto("/");
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
});
