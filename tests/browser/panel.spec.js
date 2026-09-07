import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "HA Family Bell", exact: true })).toBeVisible();
});
const tab = (page, name) => page.locator('[data-tab="' + name + '"]').click();
const dialog = page => page.getByRole("dialog");

test("draft survives refresh, save errors and an external revision conflict", async ({ page }) => {
  await tab(page, "weekly");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const message = dialog(page).locator('textarea[name="template"]');
  await message.fill("A carefully edited draft");
  await page.evaluate(() => window.emit());
  await expect(message).toHaveValue("A carefully edited draft");
  await page.evaluate(() => { window.failNext = true; });
  await dialog(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("Unable to save");
  await expect(message).toHaveValue("A carefully edited draft");
  await page.evaluate(() => { window.example.bells[0].revision++; window.emit(); });
  await expect(dialog(page).locator("#conflict")).toBeVisible();
  await dialog(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("changed elsewhere");
  await expect(message).toHaveValue("A carefully edited draft");
});

test("successful edit sends a record revision and closes the editor", async ({ page }) => {
  await tab(page, "weekly");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await dialog(page).locator('textarea[name="template"]').fill("Saved message");
  await dialog(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog(page)).not.toBeVisible();
  expect(await page.evaluate(() => window.requests.find(r => r.type === "ha_family_bell/update"))).toMatchObject({ expected_revision: 1, changes: { message_source: { kind: "template", template: "Saved message" } } });
});

test("completed event edits preserve HA time and do not rearm in another browser zone", async ({ page }) => {
  await tab(page, "one_time");
  await page.locator('[data-section="previous"] summary').click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(dialog(page).locator('input[name="time"]')).toHaveValue("08:30");
  await dialog(page).locator('textarea[name="template"]').fill("Revised event");
  await dialog(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog(page)).not.toBeVisible();
  const request = await page.evaluate(() => window.requests.find(r => r.type === "ha_family_bell/update"));
  expect(request.changes.datetime).toBe("2027-01-05T08:30:00+09:00");
  expect(request.changes).not.toHaveProperty("status");
});

test("pause preserves child selections and step toggles use atomic patches", async ({ page }) => {
  await tab(page, "routines");
  await page.locator('input[name="routine-enabled"]').uncheck();
  await expect(page.locator('input[name="routine-enabled"]')).not.toBeChecked();
  expect(await page.evaluate(() => window.example.routines[0].steps.map(s => s.enabled))).toEqual([true, false]);
  await page.locator('input[name="bell-enabled"][data-step="second"]').check();
  await expect(page.locator('input[name="bell-enabled"][data-step="second"]')).toBeChecked();
  const request = await page.evaluate(() => window.requests.find(r => r.type === "ha_family_bell/routine/patch_steps"));
  expect(request).toEqual({ type: "ha_family_bell/routine/patch_steps", routine_id: "routine", step_id: "second", enabled: true });
});

test("preview opens the exact routine step and preserves unavailable speaker selections", async ({ page }) => {
  await page.locator('[data-action="edit"][data-step="second"]').first().click();
  await expect(dialog(page).locator('input[name="time"]')).toHaveValue("07:45");
  await expect(dialog(page).locator('input[name="speakers"][value="media_player.hall"]')).toBeChecked();
  await expect(dialog(page)).toContainText("Unavailable");
});

test("restore requires a preview and changed options invalidate confirmation", async ({ page }) => {
  await tab(page, "settings");
  await page.locator('[data-action="restore"]').click();
  await expect(dialog(page).locator('[data-action="commit-operation"]')).toBeDisabled();
  const payload = await page.evaluate(() => ({ version: 2, ...window.example }));
  await dialog(page).locator('input[type="file"]').setInputFiles({ name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(payload)) });
  await dialog(page).locator('[data-action="preview-operation"]').click();
  await expect(dialog(page).locator("#operation-preview")).toContainText("2 standalone bells");
  await expect(dialog(page).locator('[data-action="commit-operation"]')).toBeEnabled();
  await dialog(page).locator('select[name="mode"]').selectOption("replace");
  await expect(dialog(page).locator('[data-action="commit-operation"]')).toBeDisabled();
});

test("dirty cancel asks before discarding", async ({ page }) => {
  await tab(page, "weekly");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await dialog(page).locator('textarea[name="template"]').fill("Do not lose this");
  page.once("dialog", prompt => prompt.dismiss());
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  page.once("dialog", prompt => prompt.accept());
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog(page)).not.toBeVisible();
});

test("disconnect releases subscriptions including a pending subscription", async ({ page }) => {
  expect(await page.evaluate(() => window.listeners.size)).toBe(1);
  await page.evaluate(async () => {
    window.panel.remove();
    window.subscriptionGate = new Promise(resolve => { window.releaseSubscription = resolve; });
    document.body.append(window.panel);
    window.panel.remove();
    window.releaseSubscription();
    await Promise.resolve();
  });
  await expect.poll(() => page.evaluate(() => window.listeners.size)).toBe(0);
});

test("mobile Korean controls remain labelled and fit the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { window.panel.hass.locale.language = "ko"; window.panel.render(); });
  await expect(page.locator('[data-tab="settings"]')).toHaveText("알림 설정");
  await tab(page, "weekly");
  await page.getByRole("button", { name: "알림 추가", exact: true }).click();
  await expect(dialog(page).getByLabel("시간", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await dialog(page).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test("schedule and preview use compact rows without losing editor access", async ({ page }) => {
  await tab(page, "weekly");
  const scheduleRow = page.locator(".bell-row").first();
  await expect(scheduleRow).toBeVisible();
  expect((await scheduleRow.boundingBox()).height).toBeLessThanOrEqual(46);
  await scheduleRow.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(dialog(page).getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();

  await tab(page, "preview");
  const previewRow = page.locator(".preview-row").first();
  await expect(previewRow).toBeVisible();
  expect((await previewRow.boundingBox()).height).toBeLessThanOrEqual(40);
});

test("new bells reuse speakers only after a successful save", async ({ page }) => {
  await tab(page, "weekly");
  await page.getByRole("button", { name: "Add bell", exact: true }).click();
  await dialog(page).locator('input[name="speakers"][value="media_player.hall"]').check();
  page.once("dialog", prompt => prompt.accept());
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("button", { name: "Add bell", exact: true }).click();
  await expect(dialog(page).locator('input[name="speakers"][value="media_player.hall"]')).not.toBeChecked();
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await dialog(page).locator('input[name="speakers"][value="media_player.study"]').uncheck();
  await dialog(page).locator('input[name="speakers"][value="media_player.hall"]').check();
  await dialog(page).getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Add bell", exact: true }).click();
  await expect(dialog(page).locator('input[name="speakers"][value="media_player.hall"]')).toBeChecked();
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await dialog(page).locator('input[name="speakers"][value="media_player.hall"]').uncheck();
  await dialog(page).locator('input[name="speakers"][value="media_player.study"]').check();
  await page.evaluate(() => { window.failNext = true; });
  await dialog(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("Unable to save");
  page.once("dialog", prompt => prompt.accept());
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Add bell", exact: true }).click();
  await expect(dialog(page).locator('input[name="speakers"][value="media_player.hall"]')).toBeChecked();
  await expect(dialog(page).locator('input[name="speakers"][value="media_player.study"]')).not.toBeChecked();
});

test("remembered speakers apply to one-time events and routine steps", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("ha-family-bell:last-speakers", '["media_player.study"]'));
  await tab(page, "one_time");
  await page.getByRole("button", { name: "Add event", exact: true }).click();
  await expect(dialog(page).locator('input[name="speakers"][value="media_player.study"]')).toBeChecked();
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();

  await tab(page, "routines");
  await page.locator('[data-action="new"][data-owner="routine"]').click();
  await expect(dialog(page).locator('input[name="speakers"][value="media_player.study"]')).toBeChecked();
});

test("one-time events separate upcoming from previous and delete finished atomically", async ({ page }) => {
  await page.evaluate(() => {
    const source = window.example.bells[0].message_source;
    const after = days => new Date(Date.now() + days * 86400000).toISOString();
    window.example.bells.push(
      { id: "later", revision: 1, name: "Later event", type: "one_time", status: "pending", datetime: after(2), enabled: true, message_source: source, speakers: ["media_player.study"] },
      { id: "next", revision: 1, name: "Next event", type: "one_time", status: "pending", datetime: after(1), enabled: true, message_source: source, speakers: ["media_player.study"] },
      { id: "missed", revision: 1, name: "Missed event", type: "one_time", status: "missed", datetime: after(-1), enabled: true, message_source: source, speakers: ["media_player.study"] },
    );
    window.emit();
  });
  await tab(page, "one_time");

  const upcoming = page.locator('[data-section="upcoming"]');
  await expect(upcoming.locator(".bell-row")).toHaveCount(2);
  await expect(upcoming.locator(".bell-row").nth(0)).toContainText("Next event");
  await expect(upcoming.locator(".bell-row").nth(1)).toContainText("Later event");

  const previous = page.locator('[data-section="previous"]');
  await expect(previous).not.toHaveAttribute("open", "");
  await previous.locator("summary").click();
  await expect(previous.locator(".bell-row")).toHaveCount(2);

  page.once("dialog", prompt => prompt.dismiss());
  await page.getByRole("button", { name: "Delete finished events", exact: true }).click();
  await expect(previous.locator(".bell-row")).toHaveCount(2);
  expect(await page.evaluate(() => window.requests.some(r => r.type === "ha_family_bell/delete_finished"))).toBe(false);

  page.once("dialog", prompt => prompt.accept());
  await page.getByRole("button", { name: "Delete finished events", exact: true }).click();
  await expect(previous).toHaveCount(0);
  expect(await page.evaluate(() => window.requests.find(r => r.type === "ha_family_bell/delete_finished"))).toEqual({
    type: "ha_family_bell/delete_finished",
    expected_revision: 1,
  });
  expect(await page.evaluate(() => window.example.bells.filter(b => b.type === "one_time").map(b => b.id).sort())).toEqual(["later", "next"]);
});
