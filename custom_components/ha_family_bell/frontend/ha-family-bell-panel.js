const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

class HaFamilyBellPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.data = null;
    this.activeTab = "weekly";
    this.loading = false;
    this.error = "";
    this._hass = null;
    this._subscribed = false;
  }

  set hass(value) {
    this._hass = value;
    if (!this.data && !this.loading) this.load();
    if (!this._subscribed && value) this.subscribe();
  }
  get hass() { return this._hass; }
  set route(_value) {}
  set panel(_value) {}
  connectedCallback() { this.render(); }

  async subscribe() {
    this._subscribed = true;
    try {
      await this.hass.connection.subscribeMessage(() => this.load(), { type: "ha_family_bell/subscribe" });
    } catch (err) {
      this._subscribed = false;
      this.showError(err);
    }
  }

  async call(message) {
    try {
      this.error = "";
      const result = await this.hass.callWS(message);
      await this.load();
      return result;
    } catch (err) {
      this.showError(err);
      throw err;
    }
  }

  async load() {
    if (!this.hass || this.loading) return;
    this.loading = true;
    try {
      this.data = await this.hass.callWS({ type: "ha_family_bell/list" });
      this.error = "";
    } catch (err) {
      this.showError(err);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  showError(err) {
    this.error = err?.message || err?.error?.message || String(err);
    this.render();
  }

  escape(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }

  speakers() {
    if (!this.hass) return [];
    return Object.values(this.hass.states)
      .filter((state) => state.entity_id.startsWith("media_player."))
      .sort((a, b) => this.name(a).localeCompare(this.name(b)));
  }
  name(state) { return state.attributes.friendly_name || state.entity_id; }

  friendlyTemplate(value) {
    return String(value || "")
      .replace(/{{\s*now\(\)\.strftime\((['"])%H:%M\1\)\s*}}/g, "%time%")
      .replace(/{{\s*random_message\s*}}/g, "%randomset%");
  }

  previewMessage(template, setId) {
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const set = (this.data?.message_sets || []).find((item) => item.id === setId);
    const sample = set?.messages.find((item) => item.enabled)?.text || "random message";
    return this.friendlyTemplate(template).replaceAll("%time%", time).replaceAll("%randomset%", sample);
  }

  speakerPicker(record) {
    const selected = new Set(record.speakers || []);
    const label = selected.size ? `${selected.size} speaker${selected.size === 1 ? "" : "s"}` : "Choose speakers";
    return `<details class="speaker-picker"><summary>${label}</summary><div class="speaker-options">
      ${this.speakers().map((state) => `<label><input type="checkbox" data-speaker="${this.escape(state.entity_id)}" ${selected.has(state.entity_id) ? "checked" : ""}><span>${this.escape(this.name(state))}</span></label>`).join("")}
    </div></details>`;
  }

  messageEditor(source = { kind: "template", template: "" }) {
    const linked = source.kind === "message_set";
    const friendly = this.friendlyTemplate(source.template);
    return `<div class="message-editor">
      <select data-field="message-kind" aria-label="Message type"><option value="template" ${linked ? "" : "selected"}>Direct</option><option value="message_set" ${linked ? "selected" : ""}>Random set</option></select>
      <input data-field="message-template" value="${this.escape(friendly)}" placeholder="${linked ? "%randomset%" : "Message text"}" aria-label="Message template">
      <select data-field="message-set" aria-label="Message set" ${linked ? "" : "hidden"}><option value="">Choose set…</option>${(this.data?.message_sets || []).map((set) => `<option value="${set.id}" ${source.set_id === set.id ? "selected" : ""}>${this.escape(set.name)}</option>`).join("")}</select>
      <div class="placeholder-tools"><span>Insert:</span><button type="button" data-placeholder="%time%">Time</button><button type="button" data-placeholder="%randomset%" ${linked ? "" : "hidden"}>Random message</button><small data-message-preview>Example: ${this.escape(this.previewMessage(friendly, source.set_id))}</small></div>
    </div>`;
  }

  readMessageSource(root) {
    const kind = root.querySelector('[data-field="message-kind"]').value;
    const source = {
      kind,
      template: root.querySelector('[data-field="message-template"]').value.trim(),
    };
    if (kind === "message_set") source.set_id = root.querySelector('[data-field="message-set"]').value;
    return source;
  }

  weeklyRow(bell) {
    return `<div class="bell-row" data-id="${bell.id}" data-type="weekly">
      <label class="enabled"><input data-field="enabled" type="checkbox" ${bell.enabled ? "checked" : ""}></label>
      <select data-field="weekday">${DAYS.map((day, i) => `<option value="${i}" ${bell.weekday === i ? "selected" : ""}>${day.slice(0, 3)}</option>`).join("")}</select>
      <input data-field="time" type="time" step="1" value="${this.escape(bell.time)}">
      ${this.messageEditor(bell.message_source)}${this.speakerPicker(bell)}
      <div class="actions"><button data-action="save" class="primary">Save</button><button data-action="test" title="Test now">▶</button><button data-action="copy">Copy</button><button data-action="duplicate">＋</button><button data-action="delete" class="danger">×</button></div>
    </div>`;
  }

  routineOccurrenceRow(row) {
    const message = row.message_source.kind === "message_set"
      ? this.data.message_sets.find((set) => set.id === row.message_source.set_id)?.name || "Missing set"
      : row.message_source.template;
    return `<div class="bell-row routine-summary">
      <label class="enabled"><input type="checkbox" ${row.enabled ? "checked" : ""} disabled></label>
      <span>${DAYS[row.weekday].slice(0, 3)}</span><span>${this.escape(row.time.slice(0, 5))}</span>
      <span class="summary-message"><span class="badge">${this.escape(row.routine_name)}</span>${this.escape(message)}</span>
      <span>${row.speakers.length} speaker${row.speakers.length === 1 ? "" : "s"}</span>
      <button data-open-routine="${row.routine_id}">Edit in Routines</button>
    </div>`;
  }

  oneTimeRow(bell) {
    const dateTime = new Date(bell.datetime);
    const local = new Date(dateTime.getTime() - dateTime.getTimezoneOffset() * 60000).toISOString();
    return `<div class="bell-row one-time" data-id="${bell.id}" data-type="one_time">
      <label class="enabled"><input data-field="enabled" type="checkbox" ${bell.enabled ? "checked" : ""}></label>
      <input data-field="date" type="date" value="${local.slice(0, 10)}"><input data-field="time" type="time" step="1" value="${local.slice(11, 19)}">
      ${this.messageEditor(bell.message_source)}${this.speakerPicker(bell)}
      <span class="status ${bell.status}">${this.escape(bell.status)}</span>
      <div class="actions"><button data-action="save" class="primary">Save</button><button data-action="test">▶</button><button data-action="duplicate">＋</button><button data-action="delete" class="danger">×</button></div>
    </div>`;
  }

  weeklyGrid() {
    const bells = this.data.bells.filter((bell) => bell.type === "weekly");
    return `<div class="toolbar"><div><h2>Weekly schedule</h2><p>Routine-owned rows are summaries; edit them in Routines.</p></div><button id="morning-wizard" class="primary">Create Morning Routine</button></div>` + DAYS.map((day, weekday) => {
      const rows = bells.filter((bell) => bell.weekday === weekday);
      const routineRows = this.data.routine_occurrences.filter((row) => row.weekday === weekday);
      return `<section class="day-group"><div class="day-heading"><h2>${day}</h2><button data-add="weekly" data-weekday="${weekday}">＋ Add bell</button></div>
        <div class="grid-header"><span>On</span><span>Day</span><span>Time</span><span>Message</span><span>Speakers</span><span>Actions</span></div>
        ${rows.map((bell) => this.weeklyRow(bell)).join("")}${routineRows.map((row) => this.routineOccurrenceRow(row)).join("") || (!rows.length ? `<div class="empty">No bells</div>` : "")}</section>`;
    }).join("");
  }

  oneTimeGrid() {
    const bells = this.data.bells.filter((bell) => bell.type === "one_time");
    return `<section class="day-group"><div class="day-heading"><h2>Single-time events</h2><button data-add="one_time">＋ Add event</button></div>
      <div class="grid-header one-time"><span>On</span><span>Date</span><span>Time</span><span>Message</span><span>Speakers</span><span>Status</span><span>Actions</span></div>
      ${bells.length ? bells.map((bell) => this.oneTimeRow(bell)).join("") : `<div class="empty">No single-time events</div>`}</section>`;
  }

  routineStepRow(routine, step) {
    return `<div class="routine-step" data-step-id="${step.id}">
      <label class="enabled"><input data-field="enabled" type="checkbox" ${step.enabled ? "checked" : ""}></label>
      <input data-field="name" value="${this.escape(step.name)}" placeholder="Step name">
      <input data-field="time" type="time" step="1" value="${this.escape(step.time)}">
      <details class="day-picker"><summary>${step.weekdays.map((day) => DAYS[day].slice(0, 3)).join(", ")}</summary><div>${DAYS.map((day, i) => `<label><input data-weekday="${i}" type="checkbox" ${step.weekdays.includes(i) ? "checked" : ""}>${day.slice(0, 3)}</label>`).join("")}</div></details>
      ${this.messageEditor(step.message_source)}${this.speakerPicker(step)}
      <div class="actions"><button data-step-action="test">▶</button><button data-step-action="delete" class="danger">×</button></div>
    </div>`;
  }

  routineCard(routine) {
    return `<section class="routine-card" data-routine-id="${routine.id}">
      <div class="routine-heading"><label class="enabled"><input data-routine-enabled type="checkbox" ${routine.enabled ? "checked" : ""}></label><input data-routine-name value="${this.escape(routine.name)}"><span>${routine.steps.length} steps</span><button data-routine-action="add-step">＋ Step</button><button data-routine-action="save" class="primary">Save routine</button><button data-routine-action="delete" class="danger">Delete</button></div>
      <div class="routine-header"><span>On</span><span>Step</span><span>Time</span><span>Days</span><span>Message / set</span><span>Speakers</span><span>Actions</span></div>
      ${routine.steps.length ? routine.steps.map((step) => this.routineStepRow(routine, step)).join("") : `<div class="empty">No steps yet</div>`}
    </section>`;
  }

  routinesGrid() {
    return `<div class="toolbar"><div><h2>Routines</h2><p>Each step has an exact time and its own weekdays.</p></div><button id="add-routine" class="primary">＋ Add routine</button></div>
      ${this.data.routines.length ? this.data.routines.map((routine) => this.routineCard(routine)).join("") : `<div class="empty card">No routines yet. Create Morning Routine from the Weekly Schedule.</div>`}`;
  }

  messageSetCard(set) {
    return `<section class="message-set-card" data-set-id="${set.id}"><div class="set-heading"><input data-set-name value="${this.escape(set.name)}"><span>${set.messages.filter((item) => item.enabled).length} enabled</span><button data-set-action="add">＋ Message</button><button data-set-action="save" class="primary">Save set</button><button data-set-action="delete" class="danger">Delete</button></div>
      <div class="set-items">${set.messages.map((item) => `<div class="set-item" data-message-id="${item.id}"><input data-item-enabled type="checkbox" ${item.enabled ? "checked" : ""}><textarea data-item-text>${this.escape(item.text)}</textarea><button data-item-delete class="danger">×</button></div>`).join("")}</div></section>`;
  }

  messageSetsGrid() {
    return `<div class="toolbar"><div><h2>Message sets</h2><p>Linked bells update automatically. Messages shuffle without repeats.</p></div><button id="add-message-set" class="primary">＋ Add set</button></div>
      ${this.data.message_sets.length ? this.data.message_sets.map((set) => this.messageSetCard(set)).join("") : `<div class="empty card">No message sets yet.</div>`}`;
  }

  settingsPanel() {
    const s = this.data.settings;
    return `<details class="settings"><summary>Announcement settings</summary><div class="settings-grid">
      <label>TTS service<input id="tts-service" value="${this.escape(s.tts_service)}"></label><label>Language<input id="language" value="${this.escape(s.language)}"></label>
      <label>Intro delay<input id="intro-delay" type="number" min="0" max="60" value="${s.intro_delay}"></label><label>Queue hold<input id="queue-hold" type="number" min="0" max="120" value="${s.queue_hold_seconds}"></label>
      <label class="wide">Intro URLs<textarea id="intro-urls">${this.escape(s.intro_urls.join("\n"))}</textarea></label><div class="settings-actions"><button id="save-settings" class="primary">Save settings</button><button id="export-json">Export JSON</button><button id="import-json">Import disabled JSON</button><input id="import-file" type="file" accept="application/json" hidden></div>
    </div></details>`;
  }

  render() {
    if (!this.shadowRoot) return;
    let main = "";
    if (this.data) {
      if (this.activeTab === "weekly") main = this.weeklyGrid();
      if (this.activeTab === "routines") main = this.routinesGrid();
      if (this.activeTab === "one_time") main = this.oneTimeGrid();
      if (this.activeTab === "message_sets") main = this.messageSetsGrid();
    }
    const body = !this.data ? `<div class="loading">${this.loading ? "Loading…" : "Waiting for Home Assistant…"}</div>` : `
      <header><div><h1>HA Family Bell</h1><p>${this.escape(this.data.timezone)} · routines · reusable messages · exact scheduling</p></div><label class="master"><input id="master" type="checkbox" ${this.data.global_enabled ? "checked" : ""}><span>${this.data.global_enabled ? "Schedule active" : "Schedule paused"}</span></label></header>
      ${this.error ? `<div class="error">${this.escape(this.error)}</div>` : ""}
      <nav>${[["weekly", "Weekly schedule"], ["routines", "Routines"], ["one_time", "Single-time events"], ["message_sets", "Message sets"]].map(([id, label]) => `<button data-tab="${id}" class="${this.activeTab === id ? "active" : ""}">${label}</button>`).join("")}</nav>
      ${this.settingsPanel()}<main>${main}</main><dialog id="editor"></dialog>`;
    this.shadowRoot.innerHTML = `<style>${this.styles()}</style><div class="page">${body}</div>`;
    this.bind();
  }

  bindMessageEditors(root = this.shadowRoot) {
    const refresh = (editor) => {
      const linked = editor.querySelector('[data-field="message-kind"]').value === "message_set";
      const setSelect = editor.querySelector('[data-field="message-set"]');
      const input = editor.querySelector('[data-field="message-template"]');
      const randomButton = editor.querySelector('[data-placeholder="%randomset%"]');
      setSelect.hidden = !linked;
      randomButton.hidden = !linked;
      editor.querySelector("[data-message-preview]").textContent = `Example: ${this.previewMessage(input.value, linked ? setSelect.value : null)}`;
    };
    root.querySelectorAll(".message-editor").forEach((editor) => {
      const kind = editor.querySelector('[data-field="message-kind"]');
      const input = editor.querySelector('[data-field="message-template"]');
      const setSelect = editor.querySelector('[data-field="message-set"]');
      kind.addEventListener("change", () => {
        const linked = kind.value === "message_set";
        if (linked && !input.value.includes("%randomset%") && !input.value.includes("random_message")) input.value = `${input.value} %randomset%`.trim();
        if (!linked) input.value = input.value.replaceAll("%randomset%", "").trim();
        refresh(editor);
      });
      input.addEventListener("input", () => refresh(editor));
      setSelect.addEventListener("change", () => refresh(editor));
      editor.querySelectorAll("[data-placeholder]").forEach((button) => button.addEventListener("click", () => {
        const token = button.dataset.placeholder;
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        input.value = `${input.value.slice(0, start)}${token}${input.value.slice(end)}`;
        input.focus();
        input.setSelectionRange(start + token.length, start + token.length);
        refresh(editor);
      }));
      refresh(editor);
    });
  }

  bind() {
    if (!this.data) return;
    this.bindMessageEditors();
    this.shadowRoot.querySelector("#master")?.addEventListener("change", (event) => this.call({ type: "ha_family_bell/set_enabled", enabled: event.target.checked }));
    this.shadowRoot.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => { this.activeTab = button.dataset.tab; this.render(); }));
    this.shadowRoot.querySelectorAll("[data-add]").forEach((button) => button.addEventListener("click", () => this.openBellEditor(button.dataset.add, Number(button.dataset.weekday || 0))));
    this.shadowRoot.querySelectorAll(".bell-row button[data-action]").forEach((button) => button.addEventListener("click", () => this.bellAction(button.closest(".bell-row"), button.dataset.action)));
    this.shadowRoot.querySelectorAll("[data-open-routine]").forEach((button) => button.addEventListener("click", () => { this.activeTab = "routines"; this.render(); this.shadowRoot.querySelector(`[data-routine-id="${button.dataset.openRoutine}"]`)?.scrollIntoView(); }));
    this.shadowRoot.querySelector("#morning-wizard")?.addEventListener("click", () => this.openMorningWizard());
    this.shadowRoot.querySelector("#add-routine")?.addEventListener("click", () => this.openNewRoutine());
    this.shadowRoot.querySelectorAll("[data-routine-action]").forEach((button) => button.addEventListener("click", () => this.routineAction(button.closest(".routine-card"), button.dataset.routineAction)));
    this.shadowRoot.querySelectorAll("[data-step-action]").forEach((button) => button.addEventListener("click", () => this.stepAction(button.closest(".routine-card"), button.closest(".routine-step"), button.dataset.stepAction)));
    this.shadowRoot.querySelector("#add-message-set")?.addEventListener("click", () => this.openNewMessageSet());
    this.shadowRoot.querySelectorAll("[data-set-action]").forEach((button) => button.addEventListener("click", () => this.messageSetAction(button.closest(".message-set-card"), button.dataset.setAction)));
    this.shadowRoot.querySelectorAll("[data-item-delete]").forEach((button) => button.addEventListener("click", () => button.closest(".set-item").remove()));
    this.shadowRoot.querySelector("#save-settings")?.addEventListener("click", () => this.saveSettings());
    this.shadowRoot.querySelector("#export-json")?.addEventListener("click", () => this.exportJson());
    this.shadowRoot.querySelector("#import-json")?.addEventListener("click", () => this.shadowRoot.querySelector("#import-file").click());
    this.shadowRoot.querySelector("#import-file")?.addEventListener("change", (event) => this.importJson(event.target.files[0]));
  }

  bellData(row) {
    const common = { enabled: row.querySelector('[data-field="enabled"]').checked, message_source: this.readMessageSource(row), speakers: [...row.querySelectorAll("[data-speaker]:checked")].map((el) => el.dataset.speaker) };
    if (row.dataset.type === "weekly") return { ...common, type: "weekly", weekday: Number(row.querySelector('[data-field="weekday"]').value), time: row.querySelector('[data-field="time"]').value };
    return { ...common, type: "one_time", datetime: `${row.querySelector('[data-field="date"]').value}T${row.querySelector('[data-field="time"]').value}`, status: "pending" };
  }

  async bellAction(row, action) {
    const id = row.dataset.id;
    if (action === "save") await this.call({ type: "ha_family_bell/update", bell_id: id, changes: this.bellData(row) });
    if (action === "test" && confirm("Play this bell now? Tests do not advance a random set.")) await this.call({ type: "ha_family_bell/test", bell_id: id });
    if (action === "delete" && confirm("Delete this bell?")) await this.call({ type: "ha_family_bell/delete", bell_id: id });
    if (action === "duplicate") {
      const bell = this.bellData(row); bell.enabled = false;
      if (bell.type === "one_time") bell.datetime = this.tomorrowAt(bell.datetime.slice(11));
      await this.call({ type: "ha_family_bell/create", bell });
    }
    if (action === "copy") this.openCopyDialog(id);
  }

  routineData(card) {
    return { name: card.querySelector("[data-routine-name]").value.trim(), enabled: card.querySelector("[data-routine-enabled]").checked, steps: [...card.querySelectorAll(".routine-step")].map((row) => ({
      id: row.dataset.stepId, name: row.querySelector('[data-field="name"]').value.trim(), enabled: row.querySelector('[data-field="enabled"]').checked,
      time: row.querySelector('[data-field="time"]').value, weekdays: [...row.querySelectorAll("[data-weekday]:checked")].map((el) => Number(el.dataset.weekday)),
      message_source: this.readMessageSource(row), speakers: [...row.querySelectorAll("[data-speaker]:checked")].map((el) => el.dataset.speaker),
    })) };
  }

  async routineAction(card, action) {
    const id = card.dataset.routineId;
    if (action === "save") await this.call({ type: "ha_family_bell/routine/update", routine_id: id, changes: this.routineData(card) });
    if (action === "delete" && confirm("Delete this routine? Its message sets will remain.")) await this.call({ type: "ha_family_bell/routine/delete", routine_id: id });
    if (action === "add-step") this.openStepEditor(id);
  }

  async stepAction(card, row, action) {
    if (action === "test" && confirm("Play this routine step now? Tests do not advance the shuffle.")) await this.call({ type: "ha_family_bell/routine/test_step", routine_id: card.dataset.routineId, step_id: row.dataset.stepId });
    if (action === "delete" && confirm("Delete this step?")) { row.remove(); await this.call({ type: "ha_family_bell/routine/update", routine_id: card.dataset.routineId, changes: this.routineData(card) }); }
  }

  messageSetData(card) {
    return { name: card.querySelector("[data-set-name]").value.trim(), messages: [...card.querySelectorAll(".set-item")].map((row) => ({ id: row.dataset.messageId || undefined, enabled: row.querySelector("[data-item-enabled]").checked, text: row.querySelector("[data-item-text]").value.trim() })) };
  }

  async messageSetAction(card, action) {
    const id = card.dataset.setId;
    if (action === "save") await this.call({ type: "ha_family_bell/message_set/update", set_id: id, changes: this.messageSetData(card) });
    if (action === "delete" && confirm("Delete this message set? Linked sets cannot be deleted.")) await this.call({ type: "ha_family_bell/message_set/delete", set_id: id });
    if (action === "add") {
      const container = card.querySelector(".set-items");
      container.insertAdjacentHTML("beforeend", `<div class="set-item"><input data-item-enabled type="checkbox" checked><textarea data-item-text></textarea><button data-item-delete class="danger">×</button></div>`);
      container.lastElementChild.querySelector("[data-item-delete]").addEventListener("click", (event) => event.target.closest(".set-item").remove());
    }
  }

  tomorrowAt(time) { const date = new Date(); date.setDate(date.getDate() + 1); const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10); return `${local}T${time}`; }

  openBellEditor(type, weekday) {
    const dialog = this.shadowRoot.querySelector("#editor"); const now = new Date(); now.setMinutes(now.getMinutes() + 10); const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString();
    dialog.innerHTML = `<form method="dialog"><h2>${type === "weekly" ? `Add ${DAYS[weekday]} bell` : "Add single-time event"}</h2>${type === "one_time" ? `<label>Date<input id="new-date" type="date" value="${local.slice(0, 10)}" required></label>` : ""}<label>Time<input id="new-time" type="time" step="1" value="${local.slice(11, 19)}" required></label><label>Message${this.messageEditor()}</label><label>Speakers${this.speakerPicker({ speakers: [] })}</label><div class="dialog-actions"><button value="cancel">Cancel</button><button id="create" class="primary">Create disabled</button></div></form>`;
    this.bindMessageEditors(dialog);
    dialog.querySelector("#create").addEventListener("click", async (event) => { event.preventDefault(); const bell = { type, enabled: false, message_source: this.readMessageSource(dialog), speakers: [...dialog.querySelectorAll("[data-speaker]:checked")].map((el) => el.dataset.speaker) }; if (type === "weekly") { bell.weekday = weekday; bell.time = dialog.querySelector("#new-time").value; } else bell.datetime = `${dialog.querySelector("#new-date").value}T${dialog.querySelector("#new-time").value}`; try { await this.call({ type: "ha_family_bell/create", bell }); dialog.close(); } catch (_err) {} });
    dialog.showModal();
  }

  openCopyDialog(id) {
    const dialog = this.shadowRoot.querySelector("#editor"); dialog.innerHTML = `<form method="dialog"><h2>Copy to days</h2><div class="day-checks">${DAYS.map((day, i) => `<label><input type="checkbox" value="${i}">${day}</label>`).join("")}</div><div class="dialog-actions"><button value="cancel">Cancel</button><button id="copy-confirm" class="primary">Create copies</button></div></form>`;
    dialog.querySelector("#copy-confirm").addEventListener("click", async (event) => { event.preventDefault(); const weekdays = [...dialog.querySelectorAll('input[type="checkbox"]:checked')].map((el) => Number(el.value)); if (weekdays.length) { await this.call({ type: "ha_family_bell/copy", bell_id: id, weekdays }); dialog.close(); } }); dialog.showModal();
  }

  openNewRoutine() {
    const dialog = this.shadowRoot.querySelector("#editor"); dialog.innerHTML = `<form method="dialog"><h2>New routine</h2><label>Name<input id="routine-name" value="Morning Routine" required></label><p>New routines start enabled but have no steps. The master schedule is unchanged.</p><div class="dialog-actions"><button value="cancel">Cancel</button><button id="create-routine" class="primary">Create</button></div></form>`;
    dialog.querySelector("#create-routine").addEventListener("click", async (event) => { event.preventDefault(); await this.call({ type: "ha_family_bell/routine/create", routine: { name: dialog.querySelector("#routine-name").value, enabled: true, steps: [] } }); dialog.close(); }); dialog.showModal();
  }

  openStepEditor(routineId) {
    const dialog = this.shadowRoot.querySelector("#editor"); const routine = this.data.routines.find((item) => item.id === routineId); const now = new Date(); const time = now.toTimeString().slice(0, 5);
    dialog.innerHTML = `<form method="dialog"><h2>Add routine step</h2><label>Name<input id="step-name" value="Morning bell"></label><label>Time<input id="step-time" type="time" value="${time}" required></label><label>Days<div class="day-checks">${DAYS.map((day, i) => `<label><input data-weekday="${i}" type="checkbox" checked>${day}</label>`).join("")}</div></label><label>Message${this.messageEditor()}</label><label>Speakers${this.speakerPicker({ speakers: [] })}</label><div class="dialog-actions"><button value="cancel">Cancel</button><button id="create-step" class="primary">Add disabled step</button></div></form>`;
    this.bindMessageEditors(dialog);
    dialog.querySelector("#create-step").addEventListener("click", async (event) => { event.preventDefault(); const step = { name: dialog.querySelector("#step-name").value, enabled: false, time: dialog.querySelector("#step-time").value, weekdays: [...dialog.querySelectorAll("[data-weekday]:checked")].map((el) => Number(el.dataset.weekday)), message_source: this.readMessageSource(dialog), speakers: [...dialog.querySelectorAll("[data-speaker]:checked")].map((el) => el.dataset.speaker) }; await this.call({ type: "ha_family_bell/routine/update", routine_id: routineId, changes: { steps: [...routine.steps, step] } }); dialog.close(); }); dialog.showModal();
  }

  openNewMessageSet() {
    const dialog = this.shadowRoot.querySelector("#editor"); dialog.innerHTML = `<form method="dialog"><h2>New message set</h2><label>Name<input id="set-name" value="Morning messages" required></label><label>First message<textarea id="set-message" required></textarea></label><div class="dialog-actions"><button value="cancel">Cancel</button><button id="create-set" class="primary">Create set</button></div></form>`;
    dialog.querySelector("#create-set").addEventListener("click", async (event) => { event.preventDefault(); await this.call({ type: "ha_family_bell/message_set/create", message_set: { name: dialog.querySelector("#set-name").value, messages: [{ text: dialog.querySelector("#set-message").value, enabled: true }] } }); dialog.close(); }); dialog.showModal();
  }

  openMorningWizard() {
    const dialog = this.shadowRoot.querySelector("#editor"); const weekly = this.data.bells.filter((bell) => bell.type === "weekly");
    dialog.innerHTML = `<form method="dialog"><h2>Morning Routine conversion</h2><p>Review only. Nothing changes until you preview and confirm.</p><div class="window"><label>From<input id="window-start" type="time" value="05:00"></label><label>To<input id="window-end" type="time" value="11:59"></label><label>Routine name<input id="conversion-name" value="Morning Routine"></label></div><div id="candidate-list" class="candidate-list"></div><div id="conversion-preview"></div><div class="dialog-actions"><button value="cancel">Cancel</button><button id="preview-conversion" type="button" class="primary">Preview conversion</button></div></form>`;
    const refresh = () => { const start = dialog.querySelector("#window-start").value; const end = dialog.querySelector("#window-end").value; const candidates = weekly.filter((bell) => bell.time.slice(0, 5) >= start && bell.time.slice(0, 5) <= end); dialog.querySelector("#candidate-list").innerHTML = candidates.map((bell) => `<label><input data-candidate="${bell.id}" type="checkbox" checked><span>${DAYS[bell.weekday].slice(0, 3)} ${bell.time.slice(0, 5)}</span><span>${this.escape(this.friendlyTemplate(bell.message_source.template))}</span></label>`).join("") || `<div class="empty">No bells in this window.</div>`; };
    refresh(); dialog.querySelector("#window-start").addEventListener("change", refresh); dialog.querySelector("#window-end").addEventListener("change", refresh);
    dialog.querySelector("#preview-conversion").addEventListener("click", async () => { try { const ids = [...dialog.querySelectorAll("[data-candidate]:checked")].map((el) => el.dataset.candidate); const name = dialog.querySelector("#conversion-name").value; const preview = await this.hass.callWS({ type: "ha_family_bell/conversion/preview", bell_ids: ids, name }); const target = dialog.querySelector("#conversion-preview"); target.innerHTML = `<div class="preview"><strong>${preview.source_bell_ids.length} rows → ${preview.routine.steps.length} steps + ${preview.message_sets.length} message sets</strong>${preview.routine.steps.map((step) => `<div>${step.time.slice(0, 5)} · ${step.weekdays.map((day) => DAYS[day].slice(0, 3)).join(", ")} · ${this.escape(step.name)}</div>`).join("")}<button id="commit-conversion" type="button" class="danger-fill">Replace selected rows</button></div>`; target.querySelector("#commit-conversion").addEventListener("click", async () => { if (!confirm(`Replace ${ids.length} selected weekly rows with this routine? The master switch and legacy automations will not change.`)) return; await this.call({ type: "ha_family_bell/conversion/commit", bell_ids: ids, name }); dialog.close(); this.activeTab = "routines"; this.render(); }); } catch (err) { this.showError(err); } });
    dialog.showModal();
  }

  async saveSettings() { const root = this.shadowRoot; await this.call({ type: "ha_family_bell/settings", changes: { tts_service: root.querySelector("#tts-service").value.trim(), language: root.querySelector("#language").value.trim(), intro_delay: Number(root.querySelector("#intro-delay").value), queue_hold_seconds: Number(root.querySelector("#queue-hold").value), intro_urls: root.querySelector("#intro-urls").value.split("\n").map((v) => v.trim()).filter(Boolean) } }); }
  exportJson() { const payload = JSON.stringify({ version: 2, timezone: this.data.timezone, bells: this.data.bells, routines: this.data.routines, message_sets: this.data.message_sets }, null, 2); const url = URL.createObjectURL(new Blob([payload], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = `ha-family-bell-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url); }
  async importJson(file) { if (!file) return; try { const payload = JSON.parse(await file.text()); if (!Array.isArray(payload.bells)) throw new Error("Import file must contain a bells array."); if (confirm(`Import ${payload.bells.length} bells? Every imported row will be disabled.`)) await this.call({ type: "ha_family_bell/import", bells: payload.bells }); } catch (err) { this.showError(err); } }

  styles() { return `
    :host { color: var(--primary-text-color); font-family: var(--paper-font-body1_-_font-family, sans-serif); } * { box-sizing: border-box; }
    .page { max-width: 1600px; margin: 0 auto; padding: 24px; } header,.toolbar,.routine-heading,.set-heading { display:flex; justify-content:space-between; gap:14px; align-items:center; } h1,h2 { margin:0; } header p,.toolbar p { margin:5px 0 0; color:var(--secondary-text-color); }
    button,input,select,textarea,summary { font:inherit; } button { border:1px solid var(--divider-color); border-radius:8px; padding:8px 11px; background:var(--card-background-color); color:var(--primary-text-color); cursor:pointer; } button.primary,.danger-fill { color:var(--text-primary-color); background:var(--primary-color); border-color:var(--primary-color); } button.danger,.danger-fill { color:var(--error-color); } .danger-fill { margin-top:12px; border-color:var(--error-color); background:transparent; }
    input,select,textarea { min-width:0; border:1px solid var(--divider-color); border-radius:7px; padding:9px; color:var(--primary-text-color); background:var(--card-background-color); } textarea { min-height:62px; resize:vertical; }
    .master { display:flex; align-items:center; gap:10px; padding:12px 16px; border-radius:12px; background:var(--card-background-color); box-shadow:var(--ha-card-box-shadow); font-weight:600; } .master input,.enabled input { width:20px; height:20px; accent-color:var(--primary-color); }
    nav { display:flex; gap:8px; margin:16px 0; border-bottom:1px solid var(--divider-color); overflow:auto; } nav button { border:0; border-radius:0; background:none; padding:12px 16px; white-space:nowrap; } nav button.active { color:var(--primary-color); border-bottom:3px solid var(--primary-color); font-weight:600; }
    .settings,.day-group,.routine-card,.message-set-card,.card { background:var(--card-background-color); border-radius:12px; margin-bottom:18px; box-shadow:var(--ha-card-box-shadow); } .settings { padding:14px 16px; } .settings-grid { display:grid; grid-template-columns:repeat(4,minmax(140px,1fr)); gap:12px; margin-top:16px; } .settings-grid label,dialog form>label { display:flex; flex-direction:column; gap:5px; color:var(--secondary-text-color); } .settings-grid .wide,.settings-actions { grid-column:1/-1; } .settings-actions,.actions,.dialog-actions { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
    .toolbar { margin:18px 0; } .day-heading,.routine-heading,.set-heading { padding:13px 16px; border-bottom:1px solid var(--divider-color); } .grid-header,.bell-row { display:grid; grid-template-columns:42px 76px 120px minmax(300px,2fr) minmax(160px,1fr) minmax(260px,auto); gap:9px; align-items:center; padding:9px 13px; } .grid-header.one-time,.bell-row.one-time { grid-template-columns:42px 135px 120px minmax(300px,2fr) minmax(160px,1fr) 80px minmax(220px,auto); } .grid-header,.routine-header { color:var(--secondary-text-color); font-size:12px; text-transform:uppercase; background:var(--secondary-background-color); } .bell-row { border-top:1px solid var(--divider-color); }
    .message-editor { display:grid; grid-template-columns:100px minmax(160px,1fr); gap:5px; } .message-editor [data-field="message-set"],.placeholder-tools { grid-column:1/-1; } .placeholder-tools { display:flex; align-items:center; gap:5px; flex-wrap:wrap; color:var(--secondary-text-color); font-size:11px; } .placeholder-tools button { padding:3px 7px; font-size:11px; } .placeholder-tools small { flex-basis:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } [hidden] { display:none!important; }
    .speaker-picker,.day-picker { position:relative; } .speaker-picker summary,.day-picker summary { border:1px solid var(--divider-color); border-radius:7px; padding:9px; cursor:pointer; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; } .speaker-options,.day-picker>div { position:absolute; z-index:10; min-width:250px; max-height:270px; overflow:auto; background:var(--card-background-color); border:1px solid var(--divider-color); border-radius:9px; box-shadow:var(--ha-card-box-shadow); padding:7px; } .speaker-options label,.day-picker label { display:flex; gap:8px; padding:6px; }
    .badge { display:inline-block; margin-right:8px; padding:3px 7px; border-radius:99px; color:var(--primary-color); background:color-mix(in srgb,var(--primary-color) 12%,transparent); font-size:11px; } .routine-summary { background:color-mix(in srgb,var(--primary-color) 4%,var(--card-background-color)); } .summary-message { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .routine-header,.routine-step { display:grid; grid-template-columns:42px 140px 110px 150px minmax(300px,2fr) minmax(160px,1fr) 100px; gap:8px; padding:9px 13px; align-items:center; } .routine-step { border-top:1px solid var(--divider-color); } .routine-heading [data-routine-name],.set-heading [data-set-name] { font-size:18px; font-weight:600; flex:1; }
    .set-items { padding:12px; display:grid; gap:8px; } .set-item { display:grid; grid-template-columns:35px 1fr 42px; gap:8px; align-items:center; }
    .status { font-size:12px; text-align:center; } .status.completed { color:var(--success-color); } .status.missed,.error { color:var(--error-color); } .empty,.loading { padding:28px; text-align:center; color:var(--secondary-text-color); } .error { padding:12px; border-radius:8px; background:color-mix(in srgb,var(--error-color) 12%,transparent); }
    dialog { width:min(760px,calc(100vw - 32px)); max-height:90vh; overflow:auto; border:0; border-radius:14px; padding:22px; color:var(--primary-text-color); background:var(--card-background-color); box-shadow:0 12px 45px #0007; } dialog::backdrop { background:#0008; } dialog form { display:grid; gap:14px; } .day-checks { display:grid; grid-template-columns:repeat(2,1fr); gap:8px; } .day-checks label { display:flex; gap:7px; align-items:center; } .window { display:grid; grid-template-columns:1fr 1fr 2fr; gap:8px; } .window label { display:grid; gap:5px; } .candidate-list { max-height:300px; overflow:auto; border:1px solid var(--divider-color); border-radius:8px; } .candidate-list label { display:grid; grid-template-columns:28px 90px 1fr; gap:7px; padding:7px; border-top:1px solid var(--divider-color); } .preview { padding:12px; border-radius:8px; background:var(--secondary-background-color); }
    @media(max-width:950px){ .page{padding:12px} header,.toolbar{align-items:flex-start;flex-direction:column}.settings-grid{grid-template-columns:1fr}.grid-header,.routine-header{display:none}.bell-row,.bell-row.one-time,.routine-step{grid-template-columns:42px 1fr 1fr}.message-editor,.speaker-picker,.actions,.status,.day-picker{grid-column:1/-1}.routine-heading,.set-heading{flex-wrap:wrap}.window{grid-template-columns:1fr}.candidate-list label{grid-template-columns:28px 80px 1fr} }
  `; }
}

if (!customElements.get("ha-family-bell-panel")) customElements.define("ha-family-bell-panel", HaFamilyBellPanel);
