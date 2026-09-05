import "./server.mjs";
import { chromium } from "@playwright/test";
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto("http://127.0.0.1:8792");
  await page.locator('[data-tab="settings"]').waitFor();
  await page.evaluate(() => {
    window.panel.hass.locale.language = "ko";
    window.panel.filters.hideEmpty = true;
    window.panel.render();
  });
  await page.screenshot({ path: "docs/images/panel-preview.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-action="edit"][data-step="first"]').first().click();
  await page.screenshot({ path: "docs/images/panel-editor-mobile.png" });
  await page.evaluate(() => {
    document.documentElement.style.cssText = "--primary-background-color:#141b24;--card-background-color:#1f2937;--primary-text-color:#edf2f7;--secondary-text-color:#a7b4c7;--divider-color:#465366;--secondary-background-color:#303d51;--primary-color:#83c8fc;--text-primary-color:#122638;--warning-color:#efad67;--error-color:#ff959d";
  });
  await page.screenshot({ path: "test-results/editor-dark.png" });
} finally { await browser.close(); }
process.exit(0);
