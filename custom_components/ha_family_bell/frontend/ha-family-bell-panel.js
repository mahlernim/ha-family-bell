const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

class HaFamilyBellPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.data = null;
    this.activeTab = "preview";
    this.previewActiveOnly = false;
    this.loading = false;
    this.error = "";
    this._hass = null;
    this._subscribed = false;
    this._mutating = 0;
    this._feedbackDepth = 0;
    this._reloadQueued = false;
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
      await this.hass.connection.subscribeMessage(() => {
        if (this._mutating || this._feedbackDepth) this._reloadQueued = true;
        else this.load();
      }, { type: "ha_family_bell/subscribe" });
    } catch (err) {
      this._subscribed = false;
      this.showError(err);
    }
  }

  async mutate(message, { reload = true } = {}) {
    this._mutating += 1;
    try {
      this.error = "";
      const result = await this.hass.callWS(message);
      if (reload) {
        this._reloadQueued = false;
        await this.load();
      } else {
        this._reloadQueued = false;
      }
      return result;
    } catch (err) {
      this.showError(err);
      throw err;
    } finally {
      this._mutating = Math.max(0, this._mutating - 1);
    }
  }

  async call(message) { return this.mutate(message); }

  async saveWithFeedback(button, message, successLabel = "Saved") {
    const initialLabel = button.textContent;
    const started = Date.now();
    this._feedbackDepth += 1;
    button.disabled = true;
    button.classList.add("is-saving");
    button.textContent = "Saving…";
    try {
      await this.mutate(message, { reload: false });
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 450 - (Date.now() - started))));
      button.classList.remove("is-saving");
      button.classList.add("is-saved");
      button.textContent = `✓ ${successLabel}`;
      await new Promise((resolve) => setTimeout(resolve, 850));
      await this.load();
    } catch (_err) {
      if (button.isConnected) {
        button.disabled = false;
        button.classList.remove("is-saving", "is-saved");
        button.textContent = initialLabel;
      }
    } finally {
      this._feedbackDepth = Math.max(0, this._feedbackDepth - 1);
      this._reloadQueued = false;
    }
  }

  async toggleWithFeedback(input, message, { onSuccess, onRollback } = {}) {
    const enabled = input.checked;
    const started = Date.now();
    this._feedbackDepth += 1;
    const container = input.closest("label") || input.parentElement;
    input.disabled = true;
    input.setAttribute("aria-busy", "true");
    container?.classList.add("toggle-busy");
    try {
      await this.mutate(message, { reload: false });
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 450 - (Date.now() - started))));
      onSuccess?.(enabled);
    } catch (_err) {
      input.checked = !enabled;
      onRollback?.(!enabled);
    } finally {
      this._feedbackDepth = Math.max(0, this._feedbackDepth - 1);
      this._reloadQueued = false;
      if (input.isConnected) {
        input.disabled = false;
        input.removeAttribute("aria-busy");
        container?.classList.remove("toggle-busy");
      }
    }
  }

  async buttonWithFeedback(button, message, { loadingLabel = "Applying…", successLabel = "Done", reload = false } = {}) {
    const initialLabel = button.textContent;
    const started = Date.now();
    this._feedbackDepth += 1;
    button.disabled = true;
    button.classList.add("is-saving");
    button.textContent = loadingLabel;
    try {
      await this.mutate(message, { reload: false });
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 280 - (Date.now() - started))));
      button.classList.remove("is-saving");
      button.classList.add("is-saved");
      button.textContent = `✓ ${successLabel}`;
      await new Promise((resolve) => setTimeout(resolve, 650));
      if (reload) await this.load();
      else if (button.isConnected) {
        button.disabled = false;
        button.classList.remove("is-saved");
        button.textContent = initialLabel;
      }
      return true;
    } catch (_err) {
      if (button.isConnected) {
        button.disabled = false;
        button.classList.remove("is-saving", "is-saved");
        button.textContent = initialLabel;
      }
      return false;
    } finally {
      this._feedbackDepth = Math.max(0, this._feedbackDepth - 1);
      this._reloadQueued = false;
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
      <div class="actions"><button data-action="save" class="primary">Save</button><button data-action="test" data-tooltip="Play now" aria-label="Play now">▶</button><button data-action="copy" title="Copy to other days">Days</button><button data-action="duplicate" title="Duplicate bell" aria-label="Duplicate bell">⧉</button><button data-action="delete" class="danger" data-tooltip="Delete bell" aria-label="Delete bell">×</button></div>
    </div>`;
  }

  previewMessageText(source) {
    return this.friendlyTemplate(source.template);
  }

  speakerSummary(speakers) {
    const byId = new Map(this.speakers().map((state) => [state.entity_id, this.name(state)]));
    return speakers.map((entityId) => byId.get(entityId) || entityId).join(", ") || "No speakers";
  }

  sourceColor(sourceKey) {
    const palette = ["#1689d8", "#a855f7", "#f97316", "#10a37f", "#ec4899", "#6366f1", "#14b8a6", "#a16207"];
    const sources = ["weekly", ...this.data.routines.map((routine) => routine.id), "one-time"];
    return palette[Math.max(sources.indexOf(sourceKey), 0) % palette.length];
  }

  previewEntries() {
    const entries = this.data.bells.filter((bell) => bell.type === "weekly").map((bell) => ({
      key: `weekly:${bell.id}:${bell.weekday}`,
      weekday: bell.weekday,
      time: bell.time,
      enabled: bell.enabled,
      source: "Weekly",
      sourceKey: "weekly",
      message: this.previewMessageText(bell.message_source),
      speakers: bell.speakers,
      ownerType: "weekly",
      ownerId: bell.id,
    }));
    for (const row of this.data.routine_occurrences) {
      entries.push({
        key: `routine:${row.routine_id}:${row.step_id}:${row.weekday}`,
        weekday: row.weekday,
        time: row.time,
        enabled: row.enabled,
        source: row.routine_name,
        sourceKey: row.routine_id,
        message: this.previewMessageText(row.message_source),
        speakers: row.speakers,
        ownerType: "routine",
        ownerId: row.routine_id,
        stepId: row.step_id,
      });
    }
    const groups = new Map();
    for (const entry of entries) {
      const key = `${entry.weekday}:${entry.time}`;
      groups.set(key, [...(groups.get(key) || []), entry]);
    }
    for (const rows of groups.values()) {
      for (let left = 0; left < rows.length; left += 1) {
        for (let right = left + 1; right < rows.length; right += 1) {
          if (rows[left].speakers.some((speaker) => rows[right].speakers.includes(speaker))) {
            rows[left].conflict = true;
            rows[right].conflict = true;
          }
        }
      }
    }
    return entries.sort((a, b) => a.weekday - b.weekday || a.time.localeCompare(b.time) || a.source.localeCompare(b.source));
  }

  previewRow(entry) {
    return `<div class="preview-row ${entry.enabled ? "" : "disabled"}" data-preview-key="${this.escape(entry.key)}">
      <strong class="preview-time">${this.escape(entry.displayTime || entry.time.slice(0, 5))}</strong>
      <span><span class="source-badge" style="--source-color:${this.sourceColor(entry.sourceKey)}">${this.escape(entry.source)}</span></span>
      <span class="preview-message" title="${this.escape(entry.message)}">${this.escape(entry.message)}</span>
      <span class="preview-speakers" title="${this.escape(this.speakerSummary(entry.speakers))}">${this.escape(this.speakerSummary(entry.speakers))}</span>
      <span class="preview-state ${entry.enabled ? "on" : "off"}">${entry.enabled ? "On" : "Off"}</span>
      <span class="preview-tools">${entry.conflict ? `<span class="conflict" title="Same time and at least one shared speaker">Conflict</span>` : ""}<button data-preview-owner="${entry.ownerType}" data-owner-id="${entry.ownerId}" ${entry.stepId ? `data-step-id="${entry.stepId}"` : ""} title="Edit source" aria-label="Edit ${this.escape(entry.source)}">✎</button></span>
    </div>`;
  }

  oneTimePreviewRow(bell) {
    const date = new Date(bell.datetime);
    const label = Number.isNaN(date.getTime()) ? bell.datetime : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    const entry = {
      key: `one-time:${bell.id}`,
      time: label,
      displayTime: label,
      enabled: bell.enabled,
      source: "One-time",
      sourceKey: "one-time",
      message: this.previewMessageText(bell.message_source),
      speakers: bell.speakers,
      ownerType: "one_time",
      ownerId: bell.id,
    };
    return this.previewRow(entry);
  }

  weekPreviewGrid() {
    const entries = this.previewEntries();
    const visible = this.previewActiveOnly ? entries.filter((entry) => entry.enabled) : entries;
    const oneTime = this.data.bells.filter((bell) => bell.type === "one_time" && bell.status === "pending" && new Date(bell.datetime).getTime() >= Date.now())
      .filter((bell) => !this.previewActiveOnly || bell.enabled)
      .sort((a, b) => a.datetime.localeCompare(b.datetime));
    return `<div class="toolbar preview-toolbar"><div><h2>Week preview</h2><p>Standalone and routine bells together, grouped by day.</p></div><label class="preview-filter"><input id="preview-active-only" type="checkbox" ${this.previewActiveOnly ? "checked" : ""}> Enabled only</label></div>
      <div class="preview-legend"><span>Time</span><span>Source</span><span>Message</span><span>Speakers</span><span>State</span><span></span></div>
      ${DAYS.map((day, weekday) => {
        const rows = visible.filter((entry) => entry.weekday === weekday);
        return `<section class="day-group preview-day"><div class="day-heading"><h2>${day}</h2><span>${rows.length} bell${rows.length === 1 ? "" : "s"}</span></div>${rows.length ? rows.map((entry) => this.previewRow(entry)).join("") : `<div class="empty compact">No bells</div>`}</section>`;
      }).join("")}
      <section class="day-group preview-day one-time-preview"><div class="day-heading"><h2>Upcoming one-time events</h2><span>${oneTime.length} event${oneTime.length === 1 ? "" : "s"}</span></div>${oneTime.length ? oneTime.map((bell) => this.oneTimePreviewRow(bell)).join("") : `<div class="empty compact">No pending events</div>`}</section>`;
  }

  oneTimeRow(bell) {
    const dateTime = new Date(bell.datetime);
    const local = new Date(dateTime.getTime() - dateTime.getTimezoneOffset() * 60000).toISOString();
    return `<div class="bell-row one-time" data-id="${bell.id}" data-type="one_time">
      <label class="enabled"><input data-field="enabled" type="checkbox" ${bell.enabled ? "checked" : ""}></label>
      <input data-field="date" type="date" value="${local.slice(0, 10)}"><input data-field="time" type="time" step="1" value="${local.slice(11, 19)}">
      ${this.messageEditor(bell.message_source)}${this.speakerPicker(bell)}
      <span class="status ${bell.status}">${this.escape(bell.status)}</span>
      <div class="actions"><button data-action="save" class="primary">Save</button><button data-action="test" data-tooltip="Play now" aria-label="Play now">▶</button><button data-action="duplicate" title="Duplicate event" aria-label="Duplicate event">＋</button><button data-action="delete" class="danger" data-tooltip="Delete event" aria-label="Delete event">×</button></div>
    </div>`;
  }

  weeklyGrid() {
    const bells = this.data.bells.filter((bell) => bell.type === "weekly");
    return `<div class="toolbar"><div><h2>Weekly schedule</h2><p>Standalone recurring bells. Routine bells are edited in Routines.</p></div><button id="morning-wizard" class="primary">Create Morning Routine</button></div>` + DAYS.map((day, weekday) => {
      const rows = bells.filter((bell) => bell.weekday === weekday);
      return `<section class="day-group"><div class="day-heading"><h2>${day}</h2><button data-add="weekly" data-weekday="${weekday}">＋ Add bell</button></div>
        <div class="grid-header"><span>On</span><span>Day</span><span>Time</span><span>Message</span><span>Speakers</span><span>Actions</span></div>
        ${rows.length ? rows.map((bell) => this.weeklyRow(bell)).join("") : `<div class="empty">No standalone bells</div>`}</section>`;
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
      <input data-field="name" type="hidden" value="${this.escape(step.name)}">
      <input data-field="time" type="time" step="1" value="${this.escape(step.time)}">
      <details class="day-picker"><summary>${step.weekdays.map((day) => DAYS[day].slice(0, 3)).join(", ")}</summary><div>${DAYS.map((day, i) => `<label><input data-weekday="${i}" type="checkbox" ${step.weekdays.includes(i) ? "checked" : ""}>${day.slice(0, 3)}</label>`).join("")}</div></details>
      ${this.messageEditor(step.message_source)}${this.speakerPicker(step)}
      <div class="actions"><button data-step-action="test" data-tooltip="Play now" aria-label="Play now">▶</button><button data-step-action="delete" class="danger" data-tooltip="Delete bell" aria-label="Delete bell">×</button></div>
    </div>`;
  }

  routineCard(routine) {
    return `<section class="routine-card" data-routine-id="${routine.id}">
      <div class="routine-heading"><label class="routine-enabled"><input data-routine-enabled type="checkbox" ${routine.enabled ? "checked" : ""}><span>Routine active</span></label><input data-routine-name value="${this.escape(routine.name)}"><span>${routine.steps.length} bell${routine.steps.length === 1 ? "" : "s"}</span><button data-routine-action="enable-all" title="Enable every bell in this routine">All on</button><button data-routine-action="disable-all" title="Disable every bell in this routine">All off</button><button data-routine-action="add-step">＋ Bell</button><button data-routine-action="save" class="primary">Save</button><button data-routine-action="delete" class="danger">Delete</button></div>
      <div class="routine-header"><span>On</span><span>Time</span><span>Days</span><span>Message / set</span><span>Speakers</span><span>Actions</span></div>
      ${routine.steps.length ? routine.steps.map((step) => this.routineStepRow(routine, step)).join("") : `<div class="empty">No bells yet</div>`}
    </section>`;
  }

  routinesGrid() {
    return `<div class="toolbar"><div><h2>Routines</h2><p>Routine active pauses the whole routine. Enable or disable all changes every bell inside it.</p></div><button id="add-routine" class="primary">＋ Add routine</button></div>
      ${this.data.routines.length ? this.data.routines.map((routine) => this.routineCard(routine)).join("") : `<div class="empty card">No routines yet. Create one from Weekly Schedule.</div>`}`;
  }

  messageSetCard(set) {
    return `<section class="message-set-card" data-set-id="${set.id}"><div class="set-heading"><input data-set-name value="${this.escape(set.name)}"><span>${set.messages.filter((item) => item.enabled).length} enabled</span><button data-set-action="add">＋ Message</button><button data-set-action="save" class="primary">Save set</button><button data-set-action="delete" class="danger">Delete</button></div>
      <div class="set-items">${set.messages.map((item) => `<div class="set-item" data-message-id="${item.id}"><input data-item-enabled type="checkbox" ${item.enabled ? "checked" : ""}><textarea data-item-text>${this.escape(item.text)}</textarea><button data-item-delete class="danger" data-tooltip="Remove message" aria-label="Remove message">×</button></div>`).join("")}</div></section>`;
  }

  messageSetsGrid() {
    return `<div class="toolbar"><div><h2>Message sets</h2><p>Linked bells update automatically. Messages shuffle without repeats.</p></div><button id="add-message-set" class="primary">＋ Add set</button></div>
      ${this.data.message_sets.length ? this.data.message_sets.map((set) => this.messageSetCard(set)).join("") : `<div class="empty card">No message sets yet.</div>`}`;
  }

  settingsPanel() {
    const s = this.data.settings;
    return `<details class="settings"><summary>Announcement settings</summary><div class="settings-grid">
      <label>TTS service<input id="tts-service" value="${this.escape(s.tts_service)}"></label><label>Language<input id="language" value="${this.escape(s.language)}"></label><label class="setting-toggle" title="Reuse identical weekly and routine speech generated by Home Assistant"><input id="cache-recurring-tts" type="checkbox" ${s.cache_recurring_tts ? "checked" : ""}> Cache recurring announcements</label>
      <label>Chime-to-speech delay<input id="intro-delay" type="number" min="0" max="60" value="${s.intro_delay}"></label><label>Queue hold<input id="queue-hold" type="number" min="0" max="120" value="${s.queue_hold_seconds}"></label>
      <label class="wide">Chime files<textarea id="intro-urls" placeholder="/local/media/chime.m4a">${this.escape(s.intro_urls.join("\n"))}</textarea><small>One media ID, path, or URL per line. One file is fixed; multiple files are chosen randomly; empty disables the chime.</small></label><div class="settings-actions"><button id="save-settings" class="primary">Save settings</button><button id="export-json">Export JSON</button><button id="import-json">Import disabled JSON</button><input id="import-file" type="file" accept="application/json" hidden></div>
    </div></details>`;
  }

  render() {
    if (!this.shadowRoot) return;
    let main = "";
    if (this.data) {
      if (this.activeTab === "preview") main = this.weekPreviewGrid();
      if (this.activeTab === "weekly") main = this.weeklyGrid();
      if (this.activeTab === "routines") main = this.routinesGrid();
      if (this.activeTab === "one_time") main = this.oneTimeGrid();
      if (this.activeTab === "message_sets") main = this.messageSetsGrid();
    }
    const body = !this.data ? `<div class="loading">${this.loading ? "Loading…" : "Waiting for Home Assistant…"}</div>` : `
      <header><div><h1>HA Family Bell</h1><p>${this.escape(this.data.timezone)} · routines · reusable messages · exact scheduling</p></div><label class="master"><input id="master" type="checkbox" ${this.data.global_enabled ? "checked" : ""}><span>${this.data.global_enabled ? "Schedule active" : "Schedule paused"}</span></label></header>
      ${this.error ? `<div class="error">${this.escape(this.error)}</div>` : ""}
      <nav>${[["preview", "Week preview"], ["weekly", "Weekly schedule"], ["routines", "Routines"], ["one_time", "Single-time events"], ["message_sets", "Message sets"]].map(([id, label]) => `<button data-tab="${id}" class="${this.activeTab === id ? "active" : ""}">${label}</button>`).join("")}</nav>
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
    this.shadowRoot.querySelector("#master")?.addEventListener("change", (event) => this.masterToggle(event.target));
    this.shadowRoot.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => { this.activeTab = button.dataset.tab; this.render(); }));
    this.shadowRoot.querySelector("#preview-active-only")?.addEventListener("change", (event) => { this.previewActiveOnly = event.target.checked; this.render(); });
    this.shadowRoot.querySelectorAll("[data-preview-owner]").forEach((button) => button.addEventListener("click", () => this.openPreviewOwner(button)));
    this.shadowRoot.querySelectorAll("[data-add]").forEach((button) => button.addEventListener("click", () => this.openBellEditor(button.dataset.add, Number(button.dataset.weekday || 0))));
    this.shadowRoot.querySelectorAll(".bell-row > .enabled [data-field=\"enabled\"]").forEach((input) => input.addEventListener("change", () => this.bellToggle(input.closest(".bell-row"), input)));
    this.shadowRoot.querySelectorAll(".bell-row button[data-action]").forEach((button) => button.addEventListener("click", () => this.bellAction(button.closest(".bell-row"), button.dataset.action, button)));
    this.shadowRoot.querySelectorAll("[data-open-routine]").forEach((button) => button.addEventListener("click", () => { this.activeTab = "routines"; this.render(); this.shadowRoot.querySelector(`[data-routine-id="${button.dataset.openRoutine}"]`)?.scrollIntoView(); }));
    this.shadowRoot.querySelector("#morning-wizard")?.addEventListener("click", () => this.openMorningWizard());
    this.shadowRoot.querySelector("#add-routine")?.addEventListener("click", () => this.openNewRoutine());
    this.shadowRoot.querySelectorAll("[data-routine-enabled]").forEach((input) => input.addEventListener("change", () => this.routineToggle(input.closest(".routine-card"), input)));
    this.shadowRoot.querySelectorAll(".routine-step > .enabled [data-field=\"enabled\"]").forEach((input) => input.addEventListener("change", () => this.stepToggle(input.closest(".routine-card"), input.closest(".routine-step"), input)));
    this.shadowRoot.querySelectorAll("[data-routine-action]").forEach((button) => button.addEventListener("click", () => this.routineAction(button.closest(".routine-card"), button.dataset.routineAction, button)));
    this.shadowRoot.querySelectorAll("[data-step-action]").forEach((button) => button.addEventListener("click", () => this.stepAction(button.closest(".routine-card"), button.closest(".routine-step"), button.dataset.stepAction)));
    this.shadowRoot.querySelector("#add-message-set")?.addEventListener("click", () => this.openNewMessageSet());
    this.shadowRoot.querySelectorAll("[data-set-action]").forEach((button) => button.addEventListener("click", () => this.messageSetAction(button.closest(".message-set-card"), button.dataset.setAction, button)));
    this.shadowRoot.querySelectorAll("[data-item-delete]").forEach((button) => button.addEventListener("click", () => button.closest(".set-item").remove()));
    this.shadowRoot.querySelector("#save-settings")?.addEventListener("click", (event) => this.saveSettings(event.currentTarget));
    this.shadowRoot.querySelector("#export-json")?.addEventListener("click", () => this.exportJson());
    this.shadowRoot.querySelector("#import-json")?.addEventListener("click", () => this.shadowRoot.querySelector("#import-file").click());
    this.shadowRoot.querySelector("#import-file")?.addEventListener("change", (event) => this.importJson(event.target.files[0]));
  }

  openPreviewOwner(button) {
    const owner = button.dataset.previewOwner;
    this.activeTab = owner === "routine" ? "routines" : owner;
    this.render();
    const selector = owner === "routine" ? `[data-routine-id="${button.dataset.ownerId}"]` : `[data-id="${button.dataset.ownerId}"]`;
    const target = this.shadowRoot.querySelector(selector);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    target?.classList.add("edit-target");
    setTimeout(() => target?.classList.remove("edit-target"), 1800);
  }

  bellData(row) {
    const common = { enabled: row.querySelector('[data-field="enabled"]').checked, message_source: this.readMessageSource(row), speakers: [...row.querySelectorAll("[data-speaker]:checked")].map((el) => el.dataset.speaker) };
    if (row.dataset.type === "weekly") return { ...common, type: "weekly", weekday: Number(row.querySelector('[data-field="weekday"]').value), time: row.querySelector('[data-field="time"]').value };
    return { ...common, type: "one_time", datetime: `${row.querySelector('[data-field="date"]').value}T${row.querySelector('[data-field="time"]').value}`, status: "pending" };
  }

  async masterToggle(input) {
    const label = input.closest("label");
    const status = label?.querySelector("span");
    const setStatus = (enabled) => { if (status) status.textContent = enabled ? "Schedule active" : "Schedule paused"; };
    setStatus(input.checked);
    await this.toggleWithFeedback(input, { type: "ha_family_bell/set_enabled", enabled: input.checked }, {
      onSuccess: (enabled) => { this.data.global_enabled = enabled; setStatus(enabled); },
      onRollback: setStatus,
    });
  }

  async bellToggle(row, input) {
    const bell = this.data.bells.find((item) => item.id === row.dataset.id);
    await this.toggleWithFeedback(input, { type: "ha_family_bell/update", bell_id: row.dataset.id, changes: { enabled: input.checked } }, {
      onSuccess: (enabled) => { if (bell) bell.enabled = enabled; },
    });
  }

  async bellAction(row, action, button) {
    const id = row.dataset.id;
    if (action === "save") await this.saveWithFeedback(button, { type: "ha_family_bell/update", bell_id: id, changes: this.bellData(row) });
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

  patchRoutineState(routine, { routineEnabled = routine.enabled, stepEnabled } = {}) {
    routine.enabled = routineEnabled;
    if (stepEnabled !== undefined) routine.steps.forEach((step) => { step.enabled = stepEnabled; });
    this.data.routine_occurrences.forEach((occurrence) => {
      if (occurrence.routine_id === routine.id) occurrence.enabled = routine.enabled && (stepEnabled ?? routine.steps.find((step) => step.id === occurrence.step_id)?.enabled);
    });
  }

  async routineToggle(card, input) {
    const routine = this.data.routines.find((item) => item.id === card.dataset.routineId);
    if (!routine) return;
    const enabled = input.checked;
    const previous = routine.steps.map((step) => step.enabled);
    const nested = [...card.querySelectorAll('.routine-step [data-field="enabled"]')];
    nested.forEach((checkbox) => { checkbox.checked = enabled; });
    const changes = { enabled, steps: routine.steps.map((step) => ({ ...step, enabled })) };
    await this.toggleWithFeedback(input, { type: "ha_family_bell/routine/update", routine_id: routine.id, changes }, {
      onSuccess: () => this.patchRoutineState(routine, { routineEnabled: enabled, stepEnabled: enabled }),
      onRollback: () => nested.forEach((checkbox, index) => { checkbox.checked = previous[index]; }),
    });
  }

  async stepToggle(card, row, input) {
    const routine = this.data.routines.find((item) => item.id === card.dataset.routineId);
    if (!routine) return;
    const enabled = input.checked;
    const steps = routine.steps.map((step) => step.id === row.dataset.stepId ? { ...step, enabled } : step);
    await this.toggleWithFeedback(input, { type: "ha_family_bell/routine/update", routine_id: routine.id, changes: { steps } }, {
      onSuccess: () => {
        const step = routine.steps.find((item) => item.id === row.dataset.stepId);
        if (step) step.enabled = enabled;
        this.data.routine_occurrences.filter((item) => item.routine_id === routine.id && item.step_id === row.dataset.stepId)
          .forEach((item) => { item.enabled = routine.enabled && enabled; });
      },
    });
  }

  async routineAction(card, action, button) {
    const id = card.dataset.routineId;
    if (action === "save") await this.saveWithFeedback(button, { type: "ha_family_bell/routine/update", routine_id: id, changes: this.routineData(card) });
    if (action === "delete" && confirm("Delete this routine? Its message sets will remain.")) await this.call({ type: "ha_family_bell/routine/delete", routine_id: id });
    if (action === "add-step") this.openStepEditor(id);
    if (action === "enable-all" || action === "disable-all") {
      const enabled = action === "enable-all";
      const count = card.querySelectorAll(".routine-step").length;
      const name = card.querySelector("[data-routine-name]").value.trim() || "this routine";
      if (!confirm(`${enabled ? "Enable" : "Disable"} all ${count} bells in ${name}? This saves immediately.`)) return;
      const routine = this.data.routines.find((item) => item.id === id);
      const checkboxes = [...card.querySelectorAll('.routine-step [data-field="enabled"]')];
      const previous = checkboxes.map((checkbox) => checkbox.checked);
      checkboxes.forEach((checkbox) => { checkbox.checked = enabled; });
      const changes = { steps: routine.steps.map((step) => ({ ...step, enabled })) };
      const saved = await this.buttonWithFeedback(button, { type: "ha_family_bell/routine/update", routine_id: id, changes }, { successLabel: "Applied" });
      if (saved) this.patchRoutineState(routine, { stepEnabled: enabled });
      else checkboxes.forEach((checkbox, index) => { checkbox.checked = previous[index]; });
    }
  }

  async stepAction(card, row, action) {
    if (action === "test" && confirm("Play this routine bell now? Tests do not advance the shuffle.")) await this.call({ type: "ha_family_bell/routine/test_step", routine_id: card.dataset.routineId, step_id: row.dataset.stepId });
    if (action === "delete" && confirm("Delete this routine bell?")) { row.remove(); await this.call({ type: "ha_family_bell/routine/update", routine_id: card.dataset.routineId, changes: this.routineData(card) }); }
  }

  messageSetData(card) {
    return { name: card.querySelector("[data-set-name]").value.trim(), messages: [...card.querySelectorAll(".set-item")].map((row) => ({ id: row.dataset.messageId || undefined, enabled: row.querySelector("[data-item-enabled]").checked, text: row.querySelector("[data-item-text]").value.trim() })) };
  }

  async messageSetAction(card, action, button) {
    const id = card.dataset.setId;
    if (action === "save") await this.saveWithFeedback(button, { type: "ha_family_bell/message_set/update", set_id: id, changes: this.messageSetData(card) }, "Saved");
    if (action === "delete" && confirm("Delete this message set? Linked sets cannot be deleted.")) await this.call({ type: "ha_family_bell/message_set/delete", set_id: id });
    if (action === "add") {
      const container = card.querySelector(".set-items");
      container.insertAdjacentHTML("beforeend", `<div class="set-item"><input data-item-enabled type="checkbox" checked><textarea data-item-text></textarea><button data-item-delete class="danger" data-tooltip="Remove message" aria-label="Remove message">×</button></div>`);
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
    const dialog = this.shadowRoot.querySelector("#editor"); dialog.innerHTML = `<form method="dialog"><h2>New routine</h2><label>Name<input id="routine-name" value="Morning Routine" required></label><p>The routine will not announce anything until it contains an enabled bell and the main schedule is active.</p><div class="dialog-actions"><button value="cancel">Cancel</button><button id="create-routine" class="primary">Create</button></div></form>`;
    dialog.querySelector("#create-routine").addEventListener("click", async (event) => { event.preventDefault(); await this.call({ type: "ha_family_bell/routine/create", routine: { name: dialog.querySelector("#routine-name").value, enabled: true, steps: [] } }); dialog.close(); }); dialog.showModal();
  }

  openStepEditor(routineId) {
    const dialog = this.shadowRoot.querySelector("#editor"); const routine = this.data.routines.find((item) => item.id === routineId); const now = new Date(); const time = now.toTimeString().slice(0, 5);
    dialog.innerHTML = `<form method="dialog"><h2>Add routine bell</h2><label>Time<input id="step-time" type="time" value="${time}" required></label><label>Days<div class="day-checks">${DAYS.map((day, i) => `<label><input data-weekday="${i}" type="checkbox" checked>${day}</label>`).join("")}</div></label><label>Message${this.messageEditor()}</label><label>Speakers${this.speakerPicker({ speakers: [] })}</label><div class="dialog-actions"><button value="cancel">Cancel</button><button id="create-step" class="primary">Add disabled bell</button></div></form>`;
    this.bindMessageEditors(dialog);
    dialog.querySelector("#create-step").addEventListener("click", async (event) => { event.preventDefault(); const selectedTime = dialog.querySelector("#step-time").value; const step = { name: `${selectedTime} bell`, enabled: false, time: selectedTime, weekdays: [...dialog.querySelectorAll("[data-weekday]:checked")].map((el) => Number(el.dataset.weekday)), message_source: this.readMessageSource(dialog), speakers: [...dialog.querySelectorAll("[data-speaker]:checked")].map((el) => el.dataset.speaker) }; await this.call({ type: "ha_family_bell/routine/update", routine_id: routineId, changes: { steps: [...routine.steps, step] } }); dialog.close(); }); dialog.showModal();
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
    dialog.querySelector("#preview-conversion").addEventListener("click", async () => { try { const ids = [...dialog.querySelectorAll("[data-candidate]:checked")].map((el) => el.dataset.candidate); const name = dialog.querySelector("#conversion-name").value; const preview = await this.hass.callWS({ type: "ha_family_bell/conversion/preview", bell_ids: ids, name }); const target = dialog.querySelector("#conversion-preview"); target.innerHTML = `<div class="preview"><strong>${preview.source_bell_ids.length} rows → ${preview.routine.steps.length} bells + ${preview.message_sets.length} message sets</strong>${preview.routine.steps.map((step) => `<div>${step.time.slice(0, 5)} · ${step.weekdays.map((day) => DAYS[day].slice(0, 3)).join(", ")} · ${this.escape(step.name)}</div>`).join("")}<button id="commit-conversion" type="button" class="danger-fill">Replace selected rows</button></div>`; target.querySelector("#commit-conversion").addEventListener("click", async () => { if (!confirm(`Replace ${ids.length} selected weekly rows with this routine? This does not enable, disable, or remove Home Assistant automations.`)) return; await this.call({ type: "ha_family_bell/conversion/commit", bell_ids: ids, name }); dialog.close(); this.activeTab = "routines"; this.render(); }); } catch (err) { this.showError(err); } });
    dialog.showModal();
  }

  async saveSettings(button) { const root = this.shadowRoot; await this.saveWithFeedback(button, { type: "ha_family_bell/settings", changes: { tts_service: root.querySelector("#tts-service").value.trim(), language: root.querySelector("#language").value.trim(), cache_recurring_tts: root.querySelector("#cache-recurring-tts").checked, intro_delay: Number(root.querySelector("#intro-delay").value), queue_hold_seconds: Number(root.querySelector("#queue-hold").value), intro_urls: root.querySelector("#intro-urls").value.split("\n").map((v) => v.trim()).filter(Boolean) } }); }
  exportJson() { const payload = JSON.stringify({ version: 2, timezone: this.data.timezone, bells: this.data.bells, routines: this.data.routines, message_sets: this.data.message_sets }, null, 2); const url = URL.createObjectURL(new Blob([payload], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = `ha-family-bell-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url); }
  async importJson(file) { if (!file) return; try { const payload = JSON.parse(await file.text()); if (!Array.isArray(payload.bells)) throw new Error("Import file must contain a bells array."); if (confirm(`Import ${payload.bells.length} bells? Every imported row will be disabled.`)) await this.call({ type: "ha_family_bell/import", bells: payload.bells }); } catch (err) { this.showError(err); } }

  styles() { return `
    :host { color: var(--primary-text-color); font-family: var(--paper-font-body1_-_font-family, sans-serif); } * { box-sizing: border-box; }
    .page { max-width: 1700px; margin: 0 auto; padding:16px 18px; } header,.toolbar,.routine-heading,.set-heading { display:flex; justify-content:space-between; gap:10px; align-items:center; } h1,h2 { margin:0; } h1 { font-size:27px; } header p,.toolbar p { margin:3px 0 0; color:var(--secondary-text-color); }
    button,input,select,textarea,summary { font:inherit; } button { border:1px solid var(--divider-color); border-radius:7px; padding:7px 9px; background:var(--card-background-color); color:var(--primary-text-color); cursor:pointer; transition:opacity .15s,background-color .15s,color .15s; } button:disabled { cursor:wait; opacity:.78; } button.primary,.danger-fill { color:var(--text-primary-color); background:var(--primary-color); border-color:var(--primary-color); } button.danger,.danger-fill { color:var(--error-color); } .danger-fill { margin-top:10px; border-color:var(--error-color); background:transparent; }
    button.is-saving::before { content:""; display:inline-block; width:12px; height:12px; margin-right:6px; border:2px solid currentColor; border-right-color:transparent; border-radius:50%; vertical-align:-2px; animation:bell-spin .7s linear infinite; } button.is-saved { color:var(--success-color); border-color:var(--success-color); background:color-mix(in srgb,var(--success-color) 10%,var(--card-background-color)); }
    button[data-tooltip] { position:relative; } button[data-tooltip]::after { content:attr(data-tooltip); position:absolute; left:50%; bottom:calc(100% + 7px); z-index:30; padding:5px 7px; border-radius:6px; color:var(--card-background-color,#fff); background:var(--primary-text-color,#222); box-shadow:0 3px 10px #0004; font-size:11px; font-weight:400; line-height:1; white-space:nowrap; pointer-events:none; opacity:0; transform:translate(-50%,3px); transition:opacity .15s,transform .15s; } button[data-tooltip]:hover::after,button[data-tooltip]:focus-visible::after { opacity:1; transform:translate(-50%,0); }
    input,select,textarea { min-width:0; border:1px solid var(--divider-color); border-radius:7px; padding:8px; color:var(--primary-text-color); background:var(--card-background-color); } textarea { min-height:54px; resize:vertical; }
    .master { display:flex; align-items:center; gap:8px; padding:10px 13px; border-radius:10px; background:var(--card-background-color); box-shadow:var(--ha-card-box-shadow); font-weight:600; } .master input,.enabled input { width:19px; height:19px; accent-color:var(--primary-color); } label.toggle-busy > input[aria-busy="true"] { display:none; } label.toggle-busy::before { content:""; display:inline-block; width:15px; height:15px; flex:0 0 15px; border:2px solid var(--primary-color); border-right-color:transparent; border-radius:50%; vertical-align:-3px; animation:bell-spin .7s linear infinite; }
    nav { display:flex; gap:5px; margin:10px 0; border-bottom:1px solid var(--divider-color); overflow:auto; } nav button { border:0; border-radius:0; background:none; padding:10px 14px; white-space:nowrap; } nav button.active { color:var(--primary-color); border-bottom:3px solid var(--primary-color); font-weight:600; }
    .settings,.day-group,.routine-card,.message-set-card,.card { background:var(--card-background-color); border-radius:10px; margin-bottom:12px; box-shadow:var(--ha-card-box-shadow); } .settings { padding:11px 13px; } .settings-grid { display:grid; grid-template-columns:repeat(4,minmax(140px,1fr)); gap:10px; margin-top:12px; } .settings-grid label,dialog form>label { display:flex; flex-direction:column; gap:5px; color:var(--secondary-text-color); } .settings-grid label small { color:var(--secondary-text-color); font-size:11px; } .settings-grid .setting-toggle { flex-direction:row; align-items:center; align-self:end; min-height:36px; } .setting-toggle input { width:18px; height:18px; accent-color:var(--primary-color); } .settings-grid .wide,.settings-actions { grid-column:1/-1; } .settings-actions,.actions,.dialog-actions { display:flex; gap:5px; flex-wrap:nowrap; justify-content:flex-end; }
    .toolbar { margin:12px 0; } .day-heading,.routine-heading,.set-heading { padding:9px 12px; border-bottom:1px solid var(--divider-color); } .day-heading { display:flex; align-items:center; justify-content:space-between; } .day-heading h2 { font-size:18px; } .grid-header,.bell-row { display:grid; grid-template-columns:36px 70px 112px minmax(300px,2fr) minmax(145px,1fr) minmax(225px,auto); gap:7px; align-items:center; padding:6px 10px; } .grid-header.one-time,.bell-row.one-time { grid-template-columns:36px 125px 112px minmax(300px,2fr) minmax(145px,1fr) 70px minmax(190px,auto); } .grid-header,.routine-header { color:var(--secondary-text-color); font-size:11px; text-transform:uppercase; background:var(--secondary-background-color); } .bell-row { border-top:1px solid var(--divider-color); }
    .message-editor { display:grid; grid-template-columns:92px minmax(150px,1fr); gap:4px; } .message-editor [data-field="message-set"],.placeholder-tools { grid-column:1/-1; } .placeholder-tools { display:flex; align-items:center; gap:4px; flex-wrap:nowrap; color:var(--secondary-text-color); font-size:10px; } .placeholder-tools button { padding:2px 6px; font-size:10px; } .placeholder-tools small { flex-basis:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .bell-row [data-message-preview],.routine-step [data-message-preview] { display:none; } .routine-step .message-editor { grid-template-columns:90px 200px minmax(160px,1fr); } .routine-step .message-editor [data-field="message-kind"] { grid-column:1; grid-row:1; } .routine-step .message-editor [data-field="message-set"] { grid-column:2; grid-row:1; } .routine-step .message-editor [data-field="message-template"] { grid-column:3; grid-row:1; } .routine-step .message-editor:has([data-field="message-set"][hidden]) [data-field="message-template"] { grid-column:2/4; } .routine-step .placeholder-tools { grid-column:1/-1; } [hidden] { display:none!important; }
    .speaker-picker,.day-picker { position:relative; } .speaker-picker summary,.day-picker summary { border:1px solid var(--divider-color); border-radius:7px; padding:9px; cursor:pointer; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; } .speaker-options,.day-picker>div { position:absolute; z-index:10; min-width:250px; max-height:270px; overflow:auto; background:var(--card-background-color); border:1px solid var(--divider-color); border-radius:9px; box-shadow:var(--ha-card-box-shadow); padding:7px; } .speaker-options label,.day-picker label { display:flex; gap:8px; padding:6px; }
    .badge { display:inline-block; margin-right:8px; padding:3px 7px; border-radius:99px; color:var(--primary-color); background:color-mix(in srgb,var(--primary-color) 12%,transparent); font-size:11px; }
    .preview-toolbar { align-items:flex-end; } .preview-filter { display:flex; align-items:center; gap:8px; padding:9px 12px; border:1px solid var(--divider-color); border-radius:9px; background:var(--card-background-color); } .preview-filter input { width:18px; height:18px; accent-color:var(--primary-color); }
    .preview-legend,.preview-row { display:grid; grid-template-columns:56px minmax(135px,auto) minmax(320px,2fr) minmax(135px,1fr) 42px minmax(54px,auto); gap:7px; align-items:center; padding:4px 10px; } .preview-legend { position:sticky; top:0; z-index:4; color:var(--secondary-text-color); background:var(--secondary-background-color); border-radius:7px; font-size:10px; text-transform:uppercase; } .preview-day { overflow:hidden; margin-bottom:8px; border-radius:8px; } .preview-day .day-heading { display:flex; justify-content:space-between; align-items:center; padding:7px 11px; } .preview-day .day-heading h2 { font-size:16px; } .preview-day .day-heading span { color:var(--secondary-text-color); font-size:10px; } .preview-row { min-height:32px; border-top:1px solid var(--divider-color); font-size:12px; } .preview-row.disabled { opacity:.58; } .preview-time { font-variant-numeric:tabular-nums; } .preview-message,.preview-speakers { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .preview-speakers { color:var(--secondary-text-color); font-size:11px; }
    .source-badge,.preview-state,.conflict { display:inline-block; width:max-content; padding:2px 5px; border-radius:99px; font-size:10px; font-weight:600; } .source-badge { color:var(--source-color); background:color-mix(in srgb,var(--source-color) 14%,transparent); } .preview-state.on { color:var(--success-color); background:color-mix(in srgb,var(--success-color) 12%,transparent); } .preview-state.off { color:var(--secondary-text-color); background:var(--secondary-background-color); } .preview-tools { display:flex; align-items:center; justify-content:flex-end; gap:4px; } .preview-tools button { padding:2px 6px; min-width:28px; font-size:13px; } .conflict { color:var(--error-color); background:color-mix(in srgb,var(--error-color) 12%,transparent); } .empty.compact { padding:10px; } .one-time-preview .preview-row { grid-template-columns:140px minmax(135px,auto) minmax(320px,2fr) minmax(135px,1fr) 42px minmax(54px,auto); } .edit-target { outline:2px solid var(--primary-color); outline-offset:-2px; transition:outline-color .3s; }
    .routine-header,.routine-step { display:grid; grid-template-columns:36px 120px 145px minmax(360px,2fr) minmax(145px,1fr) 82px; gap:7px; padding:6px 10px; align-items:center; } .routine-step { border-top:1px solid var(--divider-color); } .routine-heading [data-routine-name],.set-heading [data-set-name] { font-size:17px; font-weight:600; flex:1; } .routine-enabled { display:flex; align-items:center; gap:5px; white-space:nowrap; font-size:11px; font-weight:600; } .routine-enabled input { width:19px; height:19px; accent-color:var(--primary-color); }
    .set-items { padding:8px 10px; display:grid; gap:5px; } .set-item { display:grid; grid-template-columns:28px 1fr 36px; gap:6px; align-items:center; } .set-item textarea { min-height:38px; height:38px; padding:8px; } .set-item button { padding:6px; }
    .status { font-size:11px; text-align:center; } .status.completed { color:var(--success-color); } .status.missed,.error { color:var(--error-color); } .empty,.loading { padding:20px; text-align:center; color:var(--secondary-text-color); } .error { padding:10px; border-radius:8px; background:color-mix(in srgb,var(--error-color) 12%,transparent); }
    dialog { width:min(760px,calc(100vw - 32px)); max-height:90vh; overflow:auto; border:0; border-radius:14px; padding:22px; color:var(--primary-text-color); background:var(--card-background-color); box-shadow:0 12px 45px #0007; } dialog::backdrop { background:#0008; } dialog form { display:grid; gap:14px; } .day-checks { display:grid; grid-template-columns:repeat(2,1fr); gap:8px; } .day-checks label { display:flex; gap:7px; align-items:center; } .window { display:grid; grid-template-columns:1fr 1fr 2fr; gap:8px; } .window label { display:grid; gap:5px; } .candidate-list { max-height:300px; overflow:auto; border:1px solid var(--divider-color); border-radius:8px; } .candidate-list label { display:grid; grid-template-columns:28px 90px 1fr; gap:7px; padding:7px; border-top:1px solid var(--divider-color); } .preview { padding:12px; border-radius:8px; background:var(--secondary-background-color); }
    @keyframes bell-spin { to { transform:rotate(360deg); } }
    @media(max-width:950px){ .page{padding:10px} header,.toolbar{align-items:flex-start;flex-direction:column}.settings-grid{grid-template-columns:1fr}.grid-header,.routine-header,.preview-legend{display:none}.bell-row,.bell-row.one-time,.routine-step{grid-template-columns:36px 1fr 1fr}.message-editor,.speaker-picker,.actions,.status,.day-picker{grid-column:1/-1}.routine-step .message-editor{grid-template-columns:1fr}.routine-step .message-editor [data-field="message-kind"],.routine-step .message-editor [data-field="message-set"],.routine-step .message-editor [data-field="message-template"]{grid-column:1;grid-row:auto}.actions{flex-wrap:wrap}.routine-heading,.set-heading{flex-wrap:wrap}.window{grid-template-columns:1fr}.candidate-list label{grid-template-columns:28px 80px 1fr}.preview-row,.one-time-preview .preview-row{grid-template-columns:60px 82px 1fr;gap:6px}.preview-message,.preview-speakers{grid-column:1/-1;white-space:normal}.preview-state{grid-column:1}.preview-tools{grid-column:2/-1;justify-content:flex-end} }
  `; }
}

if (!customElements.get("ha-family-bell-panel")) customElements.define("ha-family-bell-panel", HaFamilyBellPanel);
