import { HaFamilyBellPanel } from "/ha-family-bell-panel.js";
const source = { kind: "template", template: "Good morning. %time%" };
const bell = { id: "weekly", revision: 1, type: "weekly", weekday: 0, time: "08:00:00", enabled: true, message_source: source, speakers: ["media_player.study"] };
window.example = {
  schema_version: 2, revision: 1, global_enabled: true, timezone: "Asia/Seoul",
  bells: [bell, { ...bell, id: "event", type: "one_time", status: "completed", datetime: "2027-01-05T08:30:00+09:00" }],
  routines: [{ id: "routine", revision: 1, name: "Morning routine", enabled: true, steps: [
    { id: "first", name: "Start", enabled: true, time: "07:00:00", weekdays: [0, 1, 2, 3, 4], message_source: source, speakers: ["media_player.study"] },
    { id: "second", name: "Leave", enabled: false, time: "07:45:00", weekdays: [0, 1, 2, 3, 4], message_source: source, speakers: ["media_player.hall"] },
  ] }],
  message_sets: [{ id: "set", revision: 1, name: "Daily encouragement", messages: [{ id: "one", text: "Have a good day.", enabled: true }] }],
  settings: { tts_service: "tts.google_translate_say", tts_entity_id: "", language: "en-gb", intro_urls: [], intro_delay: 4, queue_hold_seconds: 3, playback_timeout_seconds: 180, one_time_grace_seconds: 120, cache_recurring_tts: true },
  next_bell: null, history: [], activity: [], routine_occurrences: [],
};
window.requests = [];
window.listeners = new Set();
window.emit = () => { for (const listener of window.listeners) listener(); };
window.failNext = false;
window.panel = document.querySelector("ha-family-bell-panel");
const snapshot = () => {
  window.example.routine_occurrences = window.example.routines.flatMap(r => r.steps.flatMap(s => s.weekdays.map(weekday => ({
    ...s, weekday, routine_id: r.id, routine_name: r.name, step_id: s.id, enabled: r.enabled && s.enabled,
  }))));
  return structuredClone(window.example);
};
const hass = {
  language: "en", locale: { language: "en" },
  states: {
    "media_player.study": { state: "idle", attributes: { friendly_name: "Study speaker" } },
    "media_player.hall": { state: "unavailable", attributes: { friendly_name: "Hall speaker" } },
    "tts.example": { state: "unknown", attributes: { friendly_name: "Example voice" } },
  },
  connection: {
    async subscribeMessage(listener) {
      if (window.subscriptionGate) await window.subscriptionGate;
      window.listeners.add(listener); return () => window.listeners.delete(listener);
    },
  },
  async callWS(message) {
    window.requests.push(structuredClone(message));
    const command = message.type.replace("ha_family_bell/", "");
    if (command === "list") return snapshot();
    if (window.failNext) { window.failNext = false; throw Error("Unable to save. Your changes were not applied."); }
    if (command === "export") return { version: 2, ...snapshot() };
    if (command === "restore/preview") return { counts: { bells: message.payload.bells.length, routines: message.payload.routines.length, message_sets: message.payload.message_sets.length }, fingerprint: "example-preview" };
    if (command === "conversion/preview") return { routine: window.example.routines[0], revision: window.example.revision };
    if (command === "restore/commit" || command === "conversion/commit") return {};
    if (command === "test") return { status: "sent" };
    if (command === "set_enabled") window.example.global_enabled = message.enabled;
    if (command === "routine/patch_steps") {
      const routine = window.example.routines.find(r => r.id === message.routine_id);
      routine.steps.filter(s => !message.step_id || s.id === message.step_id).forEach(s => { s.enabled = message.enabled; }); routine.revision++;
    }
    const collection = command.startsWith("routine/") ? window.example.routines : command.startsWith("message_set/") ? window.example.message_sets : window.example.bells;
    if (command.endsWith("update")) {
      const item = collection.find(r => r.id === (message.bell_id || message.routine_id || message.set_id));
      if (message.expected_revision && message.expected_revision !== item.revision) throw Error("This item changed elsewhere.");
      Object.assign(item, message.changes, { revision: item.revision + 1 });
    }
    if (command.endsWith("create")) collection.push({ id: crypto.randomUUID(), revision: 1, ...message.bell || message.routine || message.message_set });
    window.example.revision++;
    window.emit();
    return {};
  },
};
window.panel.hass = hass;
window.HaFamilyBellPanel = HaFamilyBellPanel;
