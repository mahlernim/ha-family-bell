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
      await this.hass.connection.subscribeMessage(
        () => this.load(),
        { type: "ha_family_bell/subscribe" },
      );
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

  speakers() {
    if (!this.hass) return [];
    return Object.values(this.hass.states)
      .filter((state) => state.entity_id.startsWith("media_player."))
      .sort((a, b) => this.name(a).localeCompare(this.name(b)));
  }

  name(state) { return state.attributes.friendly_name || state.entity_id; }

  escape(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }

  speakerPicker(bell) {
    const selected = new Set(bell.speakers || []);
    const label = selected.size ? `${selected.size} speaker${selected.size === 1 ? "" : "s"}` : "Choose speakers";
    return `<details class="speaker-picker">
      <summary>${label}</summary>
      <div class="speaker-options">
        ${this.speakers().map((state) => `<label>
          <input type="checkbox" data-speaker="${this.escape(state.entity_id)}" ${selected.has(state.entity_id) ? "checked" : ""}>
          <span>${this.escape(this.name(state))}</span>
        </label>`).join("")}
      </div>
    </details>`;
  }

  weeklyRow(bell) {
    return `<div class="bell-row" data-id="${bell.id}" data-type="weekly">
      <label class="enabled" title="Active"><input data-field="enabled" type="checkbox" ${bell.enabled ? "checked" : ""}></label>
      <select data-field="weekday" aria-label="Day">${DAYS.map((day, i) => `<option value="${i}" ${bell.weekday === i ? "selected" : ""}>${day.slice(0, 3)}</option>`).join("")}</select>
      <input data-field="time" type="time" step="1" value="${this.escape(bell.time)}" aria-label="Time">
      <input data-field="message" type="text" value="${this.escape(bell.message)}" aria-label="Message">
      ${this.speakerPicker(bell)}
      <div class="actions">
        <button data-action="save" class="primary">Save</button>
        <button data-action="test" title="Test now">▶</button>
        <button data-action="copy" title="Copy to other days">Copy</button>
        <button data-action="duplicate" title="Duplicate">＋</button>
        <button data-action="delete" class="danger" title="Delete">×</button>
      </div>
    </div>`;
  }

  oneTimeRow(bell) {
    const dateTime = new Date(bell.datetime);
    const local = new Date(dateTime.getTime() - dateTime.getTimezoneOffset() * 60000).toISOString();
    return `<div class="bell-row one-time" data-id="${bell.id}" data-type="one_time">
      <label class="enabled"><input data-field="enabled" type="checkbox" ${bell.enabled ? "checked" : ""}></label>
      <input data-field="date" type="date" value="${local.slice(0, 10)}" aria-label="Date">
      <input data-field="time" type="time" step="1" value="${local.slice(11, 19)}" aria-label="Time">
      <input data-field="message" type="text" value="${this.escape(bell.message)}" aria-label="Message">
      ${this.speakerPicker(bell)}
      <span class="status ${bell.status}">${this.escape(bell.status)}</span>
      <div class="actions">
        <button data-action="save" class="primary">Save</button>
        <button data-action="test" title="Test now">▶</button>
        <button data-action="duplicate" title="Duplicate">＋</button>
        <button data-action="delete" class="danger" title="Delete">×</button>
      </div>
    </div>`;
  }

  weeklyGrid() {
    const bells = this.data.bells.filter((bell) => bell.type === "weekly");
    return DAYS.map((day, weekday) => {
      const rows = bells.filter((bell) => bell.weekday === weekday);
      return `<section class="day-group">
        <div class="day-heading"><h2>${day}</h2><button data-add="weekly" data-weekday="${weekday}">＋ Add bell</button></div>
        <div class="grid-header"><span>On</span><span>Day</span><span>Time</span><span>Message</span><span>Speakers</span><span>Actions</span></div>
        ${rows.length ? rows.map((bell) => this.weeklyRow(bell)).join("") : `<div class="empty">No bells</div>`}
      </section>`;
    }).join("");
  }

  oneTimeGrid() {
    const bells = this.data.bells.filter((bell) => bell.type === "one_time");
    return `<section class="day-group">
      <div class="day-heading"><h2>Single-time events</h2><button data-add="one_time">＋ Add event</button></div>
      <div class="grid-header one-time"><span>On</span><span>Date</span><span>Time</span><span>Message</span><span>Speakers</span><span>Status</span><span>Actions</span></div>
      ${bells.length ? bells.map((bell) => this.oneTimeRow(bell)).join("") : `<div class="empty">No single-time events</div>`}
    </section>`;
  }

  settingsPanel() {
    const s = this.data.settings;
    return `<details class="settings">
      <summary>Announcement settings</summary>
      <div class="settings-grid">
        <label>TTS service<input id="tts-service" value="${this.escape(s.tts_service)}"></label>
        <label>Language<input id="language" value="${this.escape(s.language)}"></label>
        <label>Intro delay (seconds)<input id="intro-delay" type="number" min="0" max="60" value="${s.intro_delay}"></label>
        <label>Minimum queue hold (seconds)<input id="queue-hold" type="number" min="0" max="120" value="${s.queue_hold_seconds}"></label>
        <label class="wide">Intro URLs, one per line<textarea id="intro-urls">${this.escape(s.intro_urls.join("\n"))}</textarea></label>
        <div class="settings-actions"><button id="save-settings" class="primary">Save settings</button><button id="export-json">Export JSON</button><button id="import-json">Import disabled JSON</button><input id="import-file" type="file" accept="application/json" hidden></div>
      </div>
    </details>`;
  }

  render() {
    if (!this.shadowRoot) return;
    const body = !this.data ? `<div class="loading">${this.loading ? "Loading…" : "Waiting for Home Assistant…"}</div>` : `
      <header>
        <div><h1>HA Family Bell</h1><p>${this.escape(this.data.timezone)} · independent rows · exact scheduling</p></div>
        <label class="master"><input id="master" type="checkbox" ${this.data.global_enabled ? "checked" : ""}><span>${this.data.global_enabled ? "Schedule active" : "Schedule paused"}</span></label>
      </header>
      ${this.error ? `<div class="error">${this.escape(this.error)}</div>` : ""}
      <nav><button data-tab="weekly" class="${this.activeTab === "weekly" ? "active" : ""}">Weekly schedule</button><button data-tab="one_time" class="${this.activeTab === "one_time" ? "active" : ""}">Single-time events</button></nav>
      ${this.settingsPanel()}
      <main>${this.activeTab === "weekly" ? this.weeklyGrid() : this.oneTimeGrid()}</main>
      <dialog id="editor"></dialog>`;
    this.shadowRoot.innerHTML = `<style>${this.styles()}</style><div class="page">${body}</div>`;
    this.bind();
  }

  bind() {
    if (!this.data) return;
    this.shadowRoot.querySelector("#master")?.addEventListener("change", (event) => {
      this.call({ type: "ha_family_bell/set_enabled", enabled: event.target.checked });
    });
    this.shadowRoot.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => {
      this.activeTab = button.dataset.tab;
      this.render();
    }));
    this.shadowRoot.querySelectorAll("[data-add]").forEach((button) => button.addEventListener("click", () => this.openEditor(button.dataset.add, Number(button.dataset.weekday || 0))));
    this.shadowRoot.querySelectorAll(".bell-row button[data-action]").forEach((button) => button.addEventListener("click", () => this.rowAction(button.closest(".bell-row"), button.dataset.action)));
    this.shadowRoot.querySelector("#save-settings")?.addEventListener("click", () => this.saveSettings());
    this.shadowRoot.querySelector("#export-json")?.addEventListener("click", () => this.exportJson());
    this.shadowRoot.querySelector("#import-json")?.addEventListener("click", () => this.shadowRoot.querySelector("#import-file").click());
    this.shadowRoot.querySelector("#import-file")?.addEventListener("change", (event) => this.importJson(event.target.files[0]));
  }

  rowData(row) {
    const speakers = [...row.querySelectorAll("[data-speaker]:checked")].map((el) => el.dataset.speaker);
    const common = {
      enabled: row.querySelector('[data-field="enabled"]').checked,
      message: row.querySelector('[data-field="message"]').value.trim(),
      speakers,
    };
    if (row.dataset.type === "weekly") return {
      ...common,
      type: "weekly",
      weekday: Number(row.querySelector('[data-field="weekday"]').value),
      time: row.querySelector('[data-field="time"]').value,
    };
    return {
      ...common,
      type: "one_time",
      datetime: `${row.querySelector('[data-field="date"]').value}T${row.querySelector('[data-field="time"]').value}`,
      status: "pending",
    };
  }

  async rowAction(row, action) {
    const id = row.dataset.id;
    if (action === "save") await this.call({ type: "ha_family_bell/update", id, changes: this.rowData(row) });
    if (action === "test" && confirm("Play this bell now on the selected speakers?")) await this.call({ type: "ha_family_bell/test", id });
    if (action === "delete" && confirm("Delete this bell? This cannot be undone.")) await this.call({ type: "ha_family_bell/delete", id });
    if (action === "duplicate") {
      const bell = this.rowData(row);
      bell.enabled = false;
      if (bell.type === "one_time") bell.datetime = this.tomorrowAt(bell.datetime.slice(11));
      await this.call({ type: "ha_family_bell/create", bell });
    }
    if (action === "copy") this.openCopyDialog(id);
  }

  tomorrowAt(time) {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    return `${local}T${time}`;
  }

  openEditor(type, weekday) {
    const dialog = this.shadowRoot.querySelector("#editor");
    const now = new Date();
    now.setMinutes(now.getMinutes() + 10);
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString();
    const shell = { speakers: [] };
    dialog.innerHTML = `<form method="dialog"><h2>${type === "weekly" ? `Add ${DAYS[weekday]} bell` : "Add single-time event"}</h2>
      ${type === "one_time" ? `<label>Date<input id="new-date" type="date" value="${local.slice(0, 10)}" required></label>` : ""}
      <label>Time<input id="new-time" type="time" step="1" value="${local.slice(11, 19)}" required></label>
      <label>Message<input id="new-message" required autofocus></label>
      <label>Speakers${this.speakerPicker(shell)}</label>
      <div class="dialog-actions"><button value="cancel">Cancel</button><button id="create" value="default" class="primary">Create</button></div></form>`;
    dialog.querySelector("#create").addEventListener("click", async (event) => {
      event.preventDefault();
      const bell = {
        type,
        enabled: false,
        message: dialog.querySelector("#new-message").value.trim(),
        speakers: [...dialog.querySelectorAll("[data-speaker]:checked")].map((el) => el.dataset.speaker),
      };
      if (type === "weekly") {
        bell.weekday = weekday;
        bell.time = dialog.querySelector("#new-time").value;
      } else {
        bell.datetime = `${dialog.querySelector("#new-date").value}T${dialog.querySelector("#new-time").value}`;
      }
      try { await this.call({ type: "ha_family_bell/create", bell }); dialog.close(); } catch (_err) {}
    });
    dialog.showModal();
  }

  openCopyDialog(id) {
    const dialog = this.shadowRoot.querySelector("#editor");
    dialog.innerHTML = `<form method="dialog"><h2>Copy to days</h2><p>Each copy is independent after creation.</p>
      <div class="day-checks">${DAYS.map((day, i) => `<label><input type="checkbox" value="${i}">${day}</label>`).join("")}</div>
      <div class="dialog-actions"><button value="cancel">Cancel</button><button id="copy-confirm" class="primary">Create copies</button></div></form>`;
    dialog.querySelector("#copy-confirm").addEventListener("click", async (event) => {
      event.preventDefault();
      const weekdays = [...dialog.querySelectorAll('input[type="checkbox"]:checked')].map((el) => Number(el.value));
      if (!weekdays.length) return;
      try { await this.call({ type: "ha_family_bell/copy", id, weekdays }); dialog.close(); } catch (_err) {}
    });
    dialog.showModal();
  }

  async saveSettings() {
    const root = this.shadowRoot;
    await this.call({
      type: "ha_family_bell/settings",
      changes: {
        tts_service: root.querySelector("#tts-service").value.trim(),
        language: root.querySelector("#language").value.trim(),
        intro_delay: Number(root.querySelector("#intro-delay").value),
        queue_hold_seconds: Number(root.querySelector("#queue-hold").value),
        intro_urls: root.querySelector("#intro-urls").value.split("\n").map((v) => v.trim()).filter(Boolean),
      },
    });
  }

  exportJson() {
    const payload = JSON.stringify({ version: 1, timezone: this.data.timezone, bells: this.data.bells }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `ha-family-bell-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async importJson(file) {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      if (!Array.isArray(payload.bells)) throw new Error("Import file must contain a bells array.");
      if (!confirm(`Import ${payload.bells.length} bells? Every imported row will be disabled.`)) return;
      await this.call({ type: "ha_family_bell/import", bells: payload.bells });
    } catch (err) { this.showError(err); }
  }

  styles() { return `
    :host { color: var(--primary-text-color); font-family: var(--paper-font-body1_-_font-family, sans-serif); }
    * { box-sizing: border-box; }
    .page { max-width: 1500px; margin: 0 auto; padding: 24px; }
    header { display: flex; justify-content: space-between; gap: 24px; align-items: center; margin-bottom: 20px; }
    h1 { margin: 0; font-size: 28px; } header p { margin: 5px 0 0; color: var(--secondary-text-color); }
    button, input, select, textarea, summary { font: inherit; }
    button { border: 1px solid var(--divider-color); border-radius: 8px; padding: 8px 11px; background: var(--card-background-color); color: var(--primary-text-color); cursor: pointer; }
    button:hover { border-color: var(--primary-color); }
    button.primary { color: var(--text-primary-color); background: var(--primary-color); border-color: var(--primary-color); }
    button.danger { color: var(--error-color); font-size: 19px; padding: 3px 10px; }
    .master { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: 12px; background: var(--card-background-color); box-shadow: var(--ha-card-box-shadow); font-weight: 600; }
    .master input, .enabled input { width: 20px; height: 20px; accent-color: var(--primary-color); }
    nav { display: flex; gap: 8px; margin: 16px 0; border-bottom: 1px solid var(--divider-color); }
    nav button { border: 0; border-radius: 0; background: none; padding: 12px 16px; }
    nav button.active { color: var(--primary-color); border-bottom: 3px solid var(--primary-color); font-weight: 600; }
    .settings { background: var(--card-background-color); border-radius: 12px; padding: 14px 16px; margin-bottom: 18px; box-shadow: var(--ha-card-box-shadow); }
    .settings > summary { cursor: pointer; font-weight: 600; }
    .settings-grid { display: grid; grid-template-columns: repeat(3, minmax(150px, 1fr)); gap: 12px; margin-top: 16px; }
    .settings-grid label, dialog form > label { display: flex; flex-direction: column; gap: 5px; color: var(--secondary-text-color); }
    .settings-grid .wide { grid-column: 1 / -1; }
    .settings-actions { grid-column: 1 / -1; display: flex; gap: 8px; flex-wrap: wrap; }
    input, select, textarea { min-width: 0; border: 1px solid var(--divider-color); border-radius: 7px; padding: 9px; color: var(--primary-text-color); background: var(--card-background-color); }
    textarea { min-height: 70px; resize: vertical; }
    .day-group { background: var(--card-background-color); border-radius: 14px; margin-bottom: 18px; box-shadow: var(--ha-card-box-shadow); overflow: visible; }
    .day-heading { display: flex; align-items: center; justify-content: space-between; padding: 13px 16px; border-bottom: 1px solid var(--divider-color); }
    .day-heading h2 { margin: 0; font-size: 18px; }
    .grid-header, .bell-row { display: grid; grid-template-columns: 42px 76px 112px minmax(220px, 2fr) minmax(180px, 1fr) minmax(275px, auto); gap: 9px; align-items: center; padding: 9px 13px; }
    .grid-header.one-time, .bell-row.one-time { grid-template-columns: 42px 135px 112px minmax(220px, 2fr) minmax(180px, 1fr) 85px minmax(225px, auto); }
    .grid-header { color: var(--secondary-text-color); font-size: 12px; font-weight: 600; text-transform: uppercase; background: var(--secondary-background-color); }
    .bell-row { border-top: 1px solid var(--divider-color); }
    .bell-row:first-of-type { border-top: 0; }
    .enabled { display: flex; justify-content: center; }
    .actions { display: flex; gap: 5px; justify-content: flex-end; }
    .speaker-picker { position: relative; }
    .speaker-picker summary { border: 1px solid var(--divider-color); border-radius: 7px; padding: 9px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .speaker-options { position: absolute; z-index: 5; right: 0; min-width: 260px; max-height: 270px; overflow: auto; background: var(--card-background-color); border: 1px solid var(--divider-color); border-radius: 9px; box-shadow: var(--ha-card-box-shadow); padding: 7px; }
    .speaker-options label { display: flex; gap: 8px; align-items: center; padding: 6px; }
    .status { font-size: 12px; text-transform: capitalize; padding: 5px 8px; border-radius: 99px; background: var(--secondary-background-color); text-align: center; }
    .status.completed { color: var(--success-color); } .status.missed { color: var(--error-color); }
    .empty, .loading { padding: 28px; text-align: center; color: var(--secondary-text-color); }
    .error { margin: 12px 0; padding: 12px; border-radius: 8px; color: var(--error-color); background: color-mix(in srgb, var(--error-color) 12%, transparent); }
    dialog { width: min(520px, calc(100vw - 32px)); border: 0; border-radius: 14px; padding: 22px; color: var(--primary-text-color); background: var(--card-background-color); box-shadow: 0 12px 45px #0007; }
    dialog::backdrop { background: #0008; } dialog h2 { margin-top: 0; } dialog form { display: grid; gap: 14px; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
    .day-checks { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
    .day-checks label { display: flex; gap: 8px; align-items: center; }
    @media (max-width: 900px) {
      .page { padding: 14px; } header { align-items: flex-start; flex-direction: column; }
      .settings-grid { grid-template-columns: 1fr; }
      .grid-header { display: none; }
      .bell-row, .bell-row.one-time { grid-template-columns: 40px 1fr 1fr; padding: 13px; }
      .bell-row [data-field="message"], .speaker-picker, .actions, .status { grid-column: 1 / -1; }
      .actions { justify-content: flex-start; flex-wrap: wrap; }
      .speaker-options { left: 0; right: auto; width: min(330px, calc(100vw - 58px)); }
    }
  `; }
}

if (!customElements.get("ha-family-bell-panel")) {
  customElements.define("ha-family-bell-panel", HaFamilyBellPanel);
}
