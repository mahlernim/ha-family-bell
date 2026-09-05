import { test } from "node:test";
import assert from "node:assert/strict";
import { wallTime, eventDatetime, tomorrow, previewEntries, translate } from "../custom_components/ha_family_bell/frontend/panel-model.js";

test("one-time editor uses HA zone and preserves an unchanged second-fold instant", () => {
  const original = "2026-11-01T01:30:00-05:00";
  const local = wallTime(original, "America/New_York");
  assert.deepEqual(local, { date: "2026-11-01", time: "01:30" });
  assert.equal(eventDatetime(original, local.date, local.time, "America/New_York"), original);
  assert.equal(eventDatetime(original, local.date, "02:00", "America/New_York"), "2026-11-01T02:00");
  assert.deepEqual(wallTime("2026-09-05T23:00:00Z", "Asia/Seoul"), { date: "2026-09-06", time: "08:00" });
  assert.equal(tomorrow("Asia/Seoul", "2026-12-31T16:00:00Z"), "2027-01-02");
});

const source = { kind: "template", template: "Hello" };
const bell = { id: "weekly", type: "weekly", weekday: 0, time: "08:00:00", enabled: true, message_source: source, speakers: ["media_player.example"] };
const event = { ...bell, id: "event", type: "one_time", status: "pending", datetime: "2026-09-07T08:00:00+09:00" };
const data = { global_enabled: true, timezone: "Asia/Seoul", bells: [bell, event], routine_occurrences: [] };
test("preview includes active one-time conflicts on the same HA local minute", () => {
  const result = previewEntries(data, Date.parse("2026-09-06T20:00:00Z"));
  assert.equal(result.recurring[0].conflict, true);
  assert.equal(result.events[0].conflict, true);
});
test("paused schedules and disabled bells do not create conflict warnings", () => {
  for (const modified of [{ ...data, global_enabled: false }, { ...data, bells: [bell, { ...event, enabled: false }] }]) {
    const result = previewEntries(modified, Date.parse("2026-09-06T20:00:00Z"));
    assert.equal(result.recurring[0].conflict, undefined);
    assert.equal(result.events[0].conflict, undefined);
  }
});
test("routine preview retains parent and step navigation identities", () => {
  const result = previewEntries({ ...data, bells: [], routine_occurrences: [{ ...bell, routine_id: "routine", step_id: "step", routine_name: "Morning", enabled: false }] });
  assert.equal(result.recurring[0].id, "routine");
  assert.equal(result.recurring[0].step_id, "step");
  assert.equal(result.recurring[0].owner, "routine");
});
test("Korean labels interpolate counts with English fallback", () => {
  assert.equal(translate("save", "ko-KR"), "저장");
  assert.equal(translate("routineCount", "ko", { count: 3 }), "루틴 알림 3개");
  assert.equal(translate("save", "de"), "Save");
});
