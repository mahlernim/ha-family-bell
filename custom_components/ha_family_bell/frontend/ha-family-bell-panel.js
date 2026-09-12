import { DAYS, wallTime, tomorrow, eventDatetime, friendlyTemplate, previewEntries, oneTimeSections, translate } from "./panel-model.js?v=0.4.2";

const escape = (value = "") => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clone = value => JSON.parse(JSON.stringify(value));
const checked = value => value ? " checked" : "";
const LAST_SPEAKERS_KEY = "ha-family-bell:last-speakers";

export class HaFamilyBellPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.data = null;
    this.activeTab = "preview";
    this.filters = { today: false, enabledOnly: false, hideEmpty: false, search: "", speaker: "" };
    this._epoch = 0;
    this._busy = false;
    this.error = "";
    this.notice = "";
    this._noticeVersion = 0;
    this.shadowRoot.innerHTML = '<link rel="stylesheet" href="' + new URL("./panel.css?v=0.4.2", import.meta.url).href + '"><main id="app"><header id="panel-header"></header><div class="summary" id="panel-summary"></div><nav aria-label="Family Bell" id="panel-tabs"></nav><div class="feedback" id="panel-feedback" role="status"></div><div class="error" id="panel-error" role="alert"></div><section id="view"></section></main><dialog id="editor"></dialog>';
    this.shadowRoot.addEventListener("click", event => this.handleClick(event));
    this.shadowRoot.addEventListener("change", event => this.handleChange(event));
    this.shadowRoot.addEventListener("input", event => this.handleInput(event));
    this.shadowRoot.addEventListener("keydown", event => this.handleKeydown(event));
    this.shadowRoot.addEventListener("focusout", () => window.setTimeout(() => this.flushSpeakerOptions(), 0));
    this.shadowRoot.addEventListener("submit", event => { event.preventDefault(); this.saveEditor(event.target); });
    this.dialog.addEventListener("cancel", event => { event.preventDefault(); this.closeEditor(); });
    this._beforeUnload = event => {
      if (this.editor?.dirty) { event.preventDefault(); event.returnValue = ""; }
    };
  }

  get dialog() { return this.shadowRoot.getElementById("editor"); }
  set hass(value) {
    this._hass = value;
    if (this.isConnected && !this.data) this.load();
    if (this.isConnected) this.subscribe();
  }
  get hass() { return this._hass; }
  t(key, values) { return translate(key, this.hass?.locale?.language || this.hass?.language || "en", values); }
  announce(message) { this.notice = message; this._noticeVersion++; }
  clearNotice() { this.notice = ""; this._noticeVersion++; }
  connectedCallback() {
    this._epoch++;
    this.load();
    this.subscribe();
    this._clock = window.setInterval(() => this.render(), 60000);
    window.addEventListener("beforeunload", this._beforeUnload);
  }
  disconnectedCallback() {
    this._epoch++;
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._subscribing = false;
    window.clearInterval(this._clock);
    window.clearTimeout(this._noticeTimer);
    window.removeEventListener("beforeunload", this._beforeUnload);
  }
  async subscribe() {
    if (!this.hass || this._unsubscribe || this._subscribing) return;
    this._subscribing = true;
    const epoch = this._epoch;
    try {
      const unsubscribe = await this.hass.connection.subscribeMessage(() => this.load(), { type: "ha_family_bell/subscribe" });
      if (epoch !== this._epoch || !this.isConnected) unsubscribe();
      else this._unsubscribe = unsubscribe;
    } catch (error) {
      if (epoch === this._epoch) { this.error = error.message || String(error); this.render(); }
    } finally { if (epoch === this._epoch) this._subscribing = false; }
  }
  async load() {
    if (!this.hass || !this.isConnected) return;
    this._reloadQueued = true;
    if (this._loading) return this._loading;
    this._loading = (async () => {
      while (this._reloadQueued && this.isConnected) {
        this._reloadQueued = false;
        try {
          this.data = await this.call("list");
          this.error = "";
          this.render();
          this.checkEditorRevision();
        } catch (error) { this.error = error.message || String(error); this.render(); }
      }
    })();
    try { await this._loading; } finally { this._loading = null; }
  }
  call(command, fields = {}) { return this.hass.callWS({ type: "ha_family_bell/" + command, ...fields }); }
  async mutate(command, fields) {
    const result = await this.call(command, fields);
    await this.load();
    return result;
  }
  button(action, text, attributes = "", primary = false) {
    return '<button type="button" data-action="' + action + '" ' + attributes + (primary ? ' class="primary"' : "") + ">" + escape(this.t(text)) + "</button>";
  }
  ref(owner, id = "", step = "", revision = "") { return 'data-owner="' + owner + '" data-id="' + escape(id) + '" data-step="' + escape(step) + '"' + (revision === "" || revision === undefined ? "" : ' data-revision="' + escape(revision) + '"'); }
  checkbox(name, labelKey, value, attrs = "") {
    return this.checkboxText(name, this.t(labelKey), value, attrs);
  }
  checkboxText(name, label, value, attrs = "") {
    return '<label class="check"><input type="checkbox" name="' + name + '"' + checked(value) + " " + attrs + ">" + escape(label) + "</label>";
  }
  field(name, label, value = "", type = "text", attrs = "") {
    return '<label class="field">' + escape(this.t(label)) + '<input name="' + name + '" type="' + type + '" value="' + escape(value) + '" ' + attrs + "></label>";
  }
  speakerName(id) { return this.hass.states[id]?.attributes?.friendly_name || id; }
  available(id) { return this.hass.states[id] && !["unavailable", "unknown"].includes(this.hass.states[id].state); }
  rememberedSpeakers() {
    try {
      const ids = JSON.parse(localStorage.getItem(LAST_SPEAKERS_KEY) || "[]");
      return Array.isArray(ids) ? ids.filter(id => typeof id === "string" && id.startsWith("media_player.")) : [];
    } catch (_error) { return []; }
  }
  rememberSpeakers(ids) {
    if (!ids.length) return;
    try { localStorage.setItem(LAST_SPEAKERS_KEY, JSON.stringify([...new Set(ids)])); } catch (_error) { /* Browser storage can be unavailable. */ }
  }
  speakerSummary(ids = []) {
    const unavailable = ids.filter(id => !this.available(id)).length;
    return '<span class="speaker-summary">' + escape(this.t("speakerCount", { count: ids.length })) + (unavailable ? ' · ' + escape(this.t("unavailableCount", { count: unavailable })) : "") + "</span>";
  }
  dateLabel(value) {
    return new Intl.DateTimeFormat(this.hass?.locale?.language || "en", { timeZone: this.data.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  }
  render() {
    const app = this.shadowRoot.getElementById("app");
    const header = this.shadowRoot.getElementById("panel-header");
    const summary = this.shadowRoot.getElementById("panel-summary");
    const tabsNode = this.shadowRoot.getElementById("panel-tabs");
    const feedback = this.shadowRoot.getElementById("panel-feedback");
    const error = this.shadowRoot.getElementById("panel-error");
    const view = this.shadowRoot.getElementById("view");
    if (!this.data) {
      header.innerHTML = "<h1>HA Family Bell</h1>";
      summary.replaceChildren(); tabsNode.replaceChildren(); feedback.textContent = ""; error.textContent = this.error || this.t("loading");
      view.innerHTML = this.button("retry", "retry");
      return;
    }
    const tabs = ["preview", "weekly", "routines", "one_time", "message_sets", "activity", "settings"];
    const next = this.data.next_bell;
    const headerHTML = '<h1>HA Family Bell</h1>' + this.checkbox("master", this.data.global_enabled ? "active" : "paused", this.data.global_enabled);
    if (header.dataset.content !== headerHTML) { header.innerHTML = headerHTML; header.dataset.content = headerHTML; }
    summary.innerHTML = '<span>' + escape(this.t("timezone")) + ": " + escape(this.data.timezone) + '</span><span><strong>' + escape(this.t("next")) + ":</strong> " + (next ? escape(this.dateLabel(next.occurrence)) + " · " + escape(friendlyTemplate(next.bell.message_source?.template)) : escape(this.t("noNext"))) + "</span>";
    const tabsHTML = tabs.map(tab => '<button type="button" data-tab="' + tab + '" aria-current="' + (tab === this.activeTab ? "page" : "false") + '">' + escape(this.t(tab)) + "</button>").join("");
    if (tabsNode.dataset.content !== tabsHTML) { tabsNode.innerHTML = tabsHTML; tabsNode.dataset.content = tabsHTML; }
    if (feedback.dataset.noticeVersion !== String(this._noticeVersion)) {
      window.clearTimeout(this._noticeTimer);
      feedback.textContent = "";
      feedback.dataset.noticeVersion = String(this._noticeVersion);
      const version = this._noticeVersion;
      if (this.notice) this._noticeTimer = window.setTimeout(() => {
        if (this.isConnected && version === this._noticeVersion) feedback.textContent = this.notice;
      }, 20);
    }
    if (error.textContent !== this.error) error.textContent = this.error;
    const locale = this.hass?.locale?.language || this.hass?.language || "en";
    if (this.activeTab === "preview" && view.dataset.kind === "preview" && view.dataset.locale === locale) this.refreshPreview();
    else {
      const details = [...view.querySelectorAll("details[data-details-id]")].map(node => [node.dataset.detailsId, node.open]);
      const openMenu = view.querySelector(".row-menu:not([hidden])");
      const menuId = openMenu?.id;
      const focusedAction = this.shadowRoot.activeElement?.dataset?.action || "";
      const active = this.shadowRoot.activeElement;
      const restoreControl = active?.closest("#preview-filters") && active.name ? { name: active.name, selectionStart: active.selectionStart, selectionEnd: active.selectionEnd } : null;
      view.dataset.kind = this.activeTab;
      view.dataset.locale = locale;
      view.innerHTML = this.view();
      for (const [id, open] of details) {
        const node = view.querySelector('details[data-details-id="' + CSS.escape(id) + '"]');
        if (node) node.open = open;
      }
      if (menuId) {
        const menu = this.shadowRoot.getElementById(menuId);
        const trigger = this.shadowRoot.querySelector('[aria-controls="' + CSS.escape(menuId) + '"]');
        if (menu && trigger) {
          menu.hidden = false; trigger.setAttribute("aria-expanded", "true");
          const focused = focusedAction ? menu.querySelector('[data-action="' + CSS.escape(focusedAction) + '"]') : null;
          if (focused) focused.focus(); else trigger.focus();
        }
      }
      if (restoreControl) {
        const control = view.querySelector('[name="' + CSS.escape(restoreControl.name) + '"]');
        control?.focus();
        if (typeof control?.setSelectionRange === "function" && restoreControl.selectionStart !== null) control.setSelectionRange(restoreControl.selectionStart, restoreControl.selectionEnd);
      }
    }
  }
  view() {
    if (this.activeTab === "preview") return this.previewView();
    if (this.activeTab === "weekly") {
      return '<div class="toolbar">' + this.button("new", "add", this.ref("weekly"), true) + this.button("convert", "convert") + "</div>" +
        DAYS.map((day, index) => { const bells = this.data.bells.filter(b => b.type === "weekly" && b.weekday === index); return '<section class="day schedule-group"><div class="group-heading"><h2>' + escape(this.t(day)) + '</h2><span>' + bells.length + '</span></div>' + (bells.map(b => this.bellCard(b, "weekly")).join("") || '<p class="muted compact-empty">' + escape(this.t("noBells")) + "</p>") + "</section>"; }).join("");
    }
    if (this.activeTab === "routines") {
      return '<div class="toolbar">' + this.button("new", "addRoutine", this.ref("routine_meta"), true) + this.button("convert", "convert") + "</div>" +
        (this.data.routines.map(r => '<details class="routine" data-details-id="routine:' + escape(r.id) + '" open><summary><strong>' + escape(r.name) + "</strong> · " + escape(this.t("routineCount", { count: r.steps.length })) + (!r.enabled ? ' <span class="badge">' + escape(this.t("paused")) + "</span>" : "") + '</summary><div class="toolbar">' + this.checkbox("routine-enabled", "enabled", r.enabled, this.ref("routine_meta", r.id, "", r.revision)) + this.button("all-on", "allOn", this.ref("routine", r.id, "", r.revision)) + this.button("all-off", "allOff", this.ref("routine", r.id, "", r.revision)) + this.button("new", "add", this.ref("routine", r.id, "", r.revision)) + this.button("edit", "edit", this.ref("routine_meta", r.id, "", r.revision)) + this.button("delete", "remove", this.ref("routine_meta", r.id, "", r.revision)) + '</div><p class="muted">' + escape(this.t("pauseRoutine")) + "</p>" + r.steps.map(s => this.bellCard(s, "routine", r.id, !r.enabled, r.revision)).join("") + "</details>").join("") || '<p class="empty">' + escape(this.t("noRoutines")) + "</p>");
    }
    if (this.activeTab === "one_time") return this.oneTimeView();
    if (this.activeTab === "message_sets") return '<div class="toolbar">' + this.button("new", "addSet", this.ref("message_set"), true) + "</div>" + (this.data.message_sets.map(s => '<article class="card"><h2>' + escape(s.name) + '</h2><ul class="messages">' + s.messages.map(m => '<li class="' + (m.enabled ? "" : "disabled") + '">' + escape(m.text) + (m.enabled ? "" : " · " + escape(this.t("off"))) + "</li>").join("") + '</ul><div class="actions">' + this.button("edit", "edit", this.ref("message_set", s.id, "", s.revision)) + this.button("delete", "remove", this.ref("message_set", s.id, "", s.revision)) + "</div></article>").join("") || '<p class="empty">' + escape(this.t("noSets")) + "</p>");
    if (this.activeTab === "activity") {
      const records = [...(this.data.activity || []), ...[...(this.data.history || [])].reverse()];
      return '<p class="muted">' + escape(this.t("requestOnly")) + "</p>" + (records.map(record => '<article class="card"><div class="row"><strong>' + escape(this.t(record.status)) + '</strong><span>' + (record.fired_at ? escape(this.dateLabel(record.fired_at)) : "") + " · " + escape(this.t(record.test ? "manual" : "scheduled")) + "</span></div><p>" + escape(record.message || record.name || "") + '</p><div class="speakers">' + Object.entries(record.speaker_results || {}).map(([id, status]) => '<span class="speaker">' + escape(this.speakerName(id)) + ": " + escape(this.t(status)) + "</span>").join("") + "</div>" + (record.error ? '<p class="error">' + escape(record.error) + "</p>" : "") + "</article>").join("") || '<p class="empty">' + escape(this.t("noActivity")) + "</p>");
    }
    const settings = this.data.settings;
    return '<article class="card"><h2>' + escape(this.t("settings")) + '</h2><dl><dt>' + escape(this.t("provider")) + "</dt><dd>" + escape(settings.tts_service === "tts.speak" ? this.speakerName(settings.tts_entity_id) : settings.tts_service) + "</dd><dt>" + escape(this.t("language")) + "</dt><dd>" + escape(settings.language) + "</dd></dl>" + this.button("edit", "edit", this.ref("settings"), true) + '</article><article class="card"><h2>' + escape(this.t("restore")) + "</h2><p>" + escape(this.t("backupInfo")) + '</p><div class="actions">' + this.button("export", "export") + this.button("restore", "restore") + "</div></article>";
  }
  bellCard(bell, owner, routineId = "", parentPaused = false, parentRevision = bell.revision) {
    const attrs = this.ref(owner, routineId || bell.id, routineId ? bell.id : "", parentRevision);
    const when = owner === "one_time" ? this.dateLabel(bell.datetime) : (bell.time?.slice(0, 5) || "") + (owner === "routine" ? " · " + bell.weekdays.map(d => this.t(DAYS[d])).join(", ") : "");
    const label = bell.name ? '<span class="bell-name">' + escape(bell.name) + "</span>" : "";
    const menuId = "actions-" + owner + "-" + (routineId || bell.id) + "-" + (routineId ? bell.id : "");
    const secondary = this.button("test", "test", attrs) + (owner === "weekly" ? this.button("copy", "copy", attrs) : owner === "one_time" ? this.button("duplicate", "duplicate", attrs) + (bell.status !== "pending" ? this.button("reschedule", "reschedule", attrs) : "") : "") + this.button("delete", "remove", attrs);
    const menuItems = secondary.replaceAll('<button type="button"', '<button type="button" role="menuitem"');
    const pausedCue = parentPaused ? this.t("routinePaused") : !bell.enabled ? this.t("bellPaused") : "";
    return '<article class="bell-row' + (bell.enabled ? "" : " disabled") + (parentPaused ? " parent-paused" : "") + '" data-kind="' + owner + '"><label class="row-toggle"><input type="checkbox" name="bell-enabled" aria-label="' + escape(this.t("enabled")) + '"' + checked(bell.enabled) + " " + attrs + "></label><strong class=\"bell-when\">" + escape(when) + '</strong><div class="bell-content">' + label + '<span class="message">' + escape(friendlyTemplate(bell.message_source?.template)) + '</span>' + (pausedCue ? '<span class="badge paused-cue">' + escape(pausedCue) + "</span>" : "") + '</div><div class="speakers">' + this.speakerSummary(bell.speakers) + '</div><div class="actions">' + (owner === "one_time" ? '<span class="badge">' + escape(this.t(bell.status)) + "</span>" : "") + this.button("edit", "edit", attrs) + '<button type="button" class="more-actions" data-action="more" aria-haspopup="menu" aria-expanded="false" aria-controls="' + escape(menuId) + '">' + escape(this.t("more")) + '</button><div class="row-menu" id="' + escape(menuId) + '" role="menu" hidden>' + menuItems + '</div><div class="desktop-actions">' + secondary + "</div></div></article>";
  }
  oneTimeView() {
    const sections = oneTimeSections(this.data.bells);
    const upcoming = '<section class="day schedule-group" data-section="upcoming"><div class="group-heading"><h2>' + escape(this.t("upcoming")) + '</h2><span>' + sections.upcoming.length + '</span></div>' + (sections.upcoming.map(bell => this.bellCard(bell, "one_time")).join("") || '<p class="muted compact-empty">' + escape(this.t("noUpcoming")) + "</p>") + "</section>";
    const previous = sections.previous.length ? '<details class="day schedule-group event-history" data-section="previous" data-details-id="previous"><summary class="group-heading"><h2>' + escape(this.t("previousEvents")) + '</h2><span>' + sections.previous.length + '</span></summary>' + sections.previous.map(bell => this.bellCard(bell, "one_time")).join("") + "</details>" : "";
    return '<div class="toolbar">' + this.button("new", "addEvent", this.ref("one_time"), true) + (sections.finishedCount ? this.button("delete-finished", "deleteFinished") : "") + "</div>" + upcoming + previous;
  }
  previewView() {
    return '<div class="filters" id="preview-filters">' + this.checkbox("today", "today", this.filters.today) + this.checkbox("enabledOnly", "enabledOnly", this.filters.enabledOnly) + this.checkbox("hideEmpty", "hideEmpty", this.filters.hideEmpty) + this.field("search", "search", this.filters.search, "search") + '<label class="field">' + escape(this.t("speakers")) + '<select name="speaker">' + this.speakerOptions() + '</select></label></div><div id="preview-results">' + this.previewResults() + "</div>";
  }
  speakerOptions() {
    const speakers = [...new Set([...Object.keys(this.hass.states).filter(id => id.startsWith("media_player.")), ...(this.filters.speaker ? [this.filters.speaker] : [])])];
    return '<option value="">' + escape(this.t("allSpeakers")) + "</option>" + speakers.map(id => '<option value="' + escape(id) + '"' + (this.filters.speaker === id ? " selected" : "") + ">" + escape(this.speakerName(id)) + (this.available(id) ? "" : " · " + escape(this.t(this.hass.states[id] ? "unavailable" : "missing"))) + "</option>").join("");
  }
  previewResults() {
    const rows = previewEntries(this.data);
    const today = wallTime(Date.now(), this.data.timezone).date;
    const weekday = (new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7;
    const matches = row => (!this.filters.enabledOnly || (this.data.global_enabled && row.enabled)) && (!this.filters.speaker || row.speakers.includes(this.filters.speaker)) && (!this.filters.search || (row.message + " " + row.source + " " + row.speakers.map(id => this.speakerName(id)).join(" ")).toLowerCase().includes(this.filters.search.toLowerCase()));
    const rowHTML = row => '<article class="preview-row' + (row.enabled && this.data.global_enabled ? "" : " disabled") + '" style="--source-color:' + this.sourceColor(row.sourceKey) + '"><strong>' + escape(row.time.slice(0, 5)) + '</strong><span class="source">' + escape(["weekly", "one_time"].includes(row.sourceKey) ? this.t(row.sourceKey) : row.source) + '</span><span class="message">' + escape(row.message) + '</span><div class="speakers">' + this.speakerSummary(row.speakers) + (row.conflict ? '<span class="badge warning" title="' + escape(this.t("queueHelp")) + '">' + escape(this.t("queue")) + "</span>" : "") + '</div>' + this.button("edit", "edit", this.ref(row.owner, row.id, row.step_id)) + "</article>";
    return DAYS.map((day, index) => {
      if (this.filters.today && index !== weekday) return "";
      const entries = rows.recurring.filter(row => row.weekday === index && matches(row));
      const date = new Date(today + "T12:00:00Z"); date.setUTCDate(date.getUTCDate() + (index - weekday + 7) % 7);
      const dateKey = date.toISOString().slice(0, 10);
      entries.push(...rows.events.filter(row => row.date === dateKey && matches(row)));
      entries.sort((a, b) => a.time.localeCompare(b.time));
      if (!entries.length && this.filters.hideEmpty) return "";
      return '<section class="day preview-day"><div class="group-heading"><h2>' + escape(this.t(day)) + (index === weekday ? ' <span class="badge">' + escape(this.t("today")) + "</span>" : "") + '</h2><span>' + entries.length + '</span></div>' + (entries.map(rowHTML).join("") || '<p class="muted compact-empty">' + escape(this.t("noBells")) + "</p>") + "</section>";
    }).join("");
  }
  sourceColor(key = "") {
    let hash = 0; for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return ["#2979b8", "#7a55ad", "#16816b", "#b85b24", "#ba4279", "#627c21"][hash % 6];
  }
  refreshPreview() {
    const node = this.shadowRoot.getElementById("preview-results");
    if (!node) return;
    this.syncSpeakerOptions();
    const openMenu = node.querySelector(".row-menu:not([hidden])");
    const focusedAction = this.shadowRoot.activeElement?.dataset?.action || "";
    const menuId = openMenu?.id;
    node.innerHTML = this.previewResults();
    if (menuId) {
      const menu = this.shadowRoot.getElementById(menuId);
      const trigger = this.shadowRoot.querySelector('[aria-controls="' + CSS.escape(menuId) + '"]');
      if (menu && trigger) {
        menu.hidden = false; trigger.setAttribute("aria-expanded", "true");
        const focused = focusedAction ? menu.querySelector('[data-action="' + CSS.escape(focusedAction) + '"]') : null;
        if (focused) focused.focus(); else trigger.focus();
      }
    }
  }
  syncSpeakerOptions() {
    const speaker = this.shadowRoot.querySelector('select[name="speaker"]');
    const options = this.speakerOptions();
    if (!speaker || speaker.dataset.options === options) return;
    if (this.shadowRoot.activeElement === speaker) { this._pendingSpeakerOptions = true; return; }
    speaker.innerHTML = options; speaker.dataset.options = options; this._pendingSpeakerOptions = false;
  }
  flushSpeakerOptions() {
    if (!this._pendingSpeakerOptions) return;
    this.syncSpeakerOptions();
  }
  editorError(error) { const node = this.dialog.querySelector("#editor-error"); if (node) node.textContent = error.message || String(error); }
  markDirty() {
    if (!this.editor) return;
    this.editor.dirty = true;
    this.editor.generation++;
    this.editor.preview = null;
    const status = this.dialog.querySelector("#draft-status");
    if (status) status.textContent = this.t("unsaved");
    const preview = this.dialog.querySelector("#operation-preview");
    if (preview) preview.replaceChildren();
    const commit = this.dialog.querySelector('[data-action="commit-operation"]');
    if (commit) commit.disabled = true;
  }
  handleInput(event) {
    if (this.dialog.contains(event.target)) this.markDirty();
    else if (event.target.name === "search") { this.filters.search = event.target.value; this.refreshPreview(); }
  }
  async handleChange(event) {
    const target = event.target;
    if (this.dialog.contains(target)) {
      this.markDirty();
      if (target.name === "kind") {
        this.dialog.querySelector('[data-field="set"]').hidden = target.value !== "message_set";
      }
      if (target.name === "provider") this.dialog.querySelector('[data-field="legacy"]').hidden = target.value !== "legacy";
      return;
    }
    if (Object.hasOwn(this.filters, target.name)) { this.filters[target.name] = target.type === "checkbox" ? target.checked : target.value; this.refreshPreview(); return; }
    const { owner, id, step } = target.dataset;
    target.disabled = true;
    try {
      if (target.name === "master") await this.mutate("set_enabled", { enabled: target.checked });
      else if (owner === "routine" && step) await this.mutate("routine/patch_steps", { routine_id: id, step_id: step, enabled: target.checked });
      else if (owner === "routine_meta") await this.mutate("routine/update", { routine_id: id, changes: { enabled: target.checked } });
      else if (target.name === "bell-enabled") await this.mutate("update", { bell_id: id, changes: { enabled: target.checked } });
    } catch (error) { this.error = error.message || String(error); this.render(); }
    finally { target.disabled = false; }
  }
  async handleClick(event) {
    const target = event.target.closest("button");
    if (!target) { this.closeRowMenus(); return; }
    if (target.disabled) return;
    if (target.dataset.tab) { this.activeTab = target.dataset.tab; this.clearNotice(); this.render(); return; }
    const { action, owner, id, step } = target.dataset;
    if (!action) { if (!target.closest(".row-menu")) this.closeRowMenus(); return; }
    if (action === "more") {
      const menu = this.shadowRoot.getElementById(target.getAttribute("aria-controls"));
      const open = menu.hidden;
      this.closeRowMenus();
      menu.hidden = !open;
      target.setAttribute("aria-expanded", String(open));
      if (open) menu.querySelector("button")?.focus();
      return;
    }
    if (["new", "edit", "duplicate", "reschedule"].includes(action)) { this.openEditor(owner, id, step, action); return; }
    if (action === "cancel") { this.closeEditor(); return; }
    if (action === "reload-editor") {
      if (this.editor.dirty && !window.confirm(this.t("discardQuestion"))) return;
      const editor = this.editor; this.closeEditor(true); this.openEditor(editor.owner, editor.id, editor.step, editor.action); return;
    }
    if (action === "add-variant") { this.dialog.querySelector("#variants").insertAdjacentHTML("beforeend", this.variantFields({ text: "", enabled: true })); this.markDirty(); return; }
    if (action === "remove-variant") { target.closest(".variant").remove(); this.markDirty(); return; }
    if (action === "insert-time" || action === "insert-random") {
      const textarea = this.dialog.querySelector('textarea[name="template"]');
      textarea.setRangeText(action === "insert-time" ? "%time%" : "%randomset%", textarea.selectionStart, textarea.selectionEnd, "end");
      textarea.focus(); this.markDirty(); return;
    }
    if (action === "restore" || action === "convert" || action === "copy") { this.openOperation(action, id); return; }
    target.disabled = true;
    try {
      if (action === "retry") { this.subscribe(); await this.load(); }
      else if (action === "export") await this.exportBackup();
      else if (action === "preview-operation") await this.previewOperation();
      else if (action === "commit-operation") await this.commitOperation();
      else if (action === "test" && window.confirm(this.t("playQuestion"))) {
        const result = await this.mutate("test", { bell_id: owner === "routine" ? id + ":" + step : id });
        this.announce(this.t(result.status) + " · " + this.t("requestOnly")); this.render();
      } else if (action === "all-on" || action === "all-off") {
        await this.mutate("routine/patch_steps", { routine_id: id, enabled: action === "all-on" });
      } else if (action === "delete-finished") {
        const count = oneTimeSections(this.data.bells).finishedCount;
        if (count && window.confirm(this.t("deleteFinishedQuestion", { count }))) {
          const result = await this.mutate("delete_finished", { expected_revision: this.data.revision });
          this.announce(this.t("deletedFinished", result)); this.render();
        }
      } else if (action === "delete") {
        const displayedRevision = Number(target.dataset.revision);
        const routine = owner === "routine" ? this.data.routines.find(item => item.id === id) : null;
        const displayedRoutine = routine ? clone(routine) : null;
        if (!Number.isInteger(displayedRevision) || (owner === "routine" && !displayedRoutine)) throw Error(this.t("deleteStale"));
        if (!window.confirm(this.t("deleteQuestion"))) return;
        if (owner === "routine") {
          await this.mutate("routine/update", { routine_id: id, expected_revision: displayedRevision, changes: { steps: displayedRoutine.steps.filter(item => item.id !== step) } });
        } else {
          const command = owner === "routine_meta" ? "routine/delete" : owner === "message_set" ? "message_set/delete" : "delete";
          const field = owner === "routine_meta" ? "routine_id" : owner === "message_set" ? "set_id" : "bell_id";
          await this.mutate(command, { [field]: id, expected_revision: displayedRevision });
        }
      }
    } catch (error) {
      if (this.dialog.open) this.editorError(error);
      else {
        if (["delete", "delete-finished"].includes(action)) {
          try { await this.load(); } catch (_reloadError) { /* Keep the original mutation error. */ }
        }
        this.error = error.message || String(error); this.render();
      }
    } finally { if (target.isConnected) target.disabled = action === "commit-operation" && !this.editor?.preview; }
  }
  closeRowMenus() {
    this.shadowRoot.querySelectorAll(".row-menu:not([hidden])").forEach(menu => {
      menu.hidden = true;
      this.shadowRoot.querySelector('[aria-controls="' + CSS.escape(menu.id) + '"]')?.setAttribute("aria-expanded", "false");
    });
  }
  handleKeydown(event) {
    const menu = event.target.closest(".row-menu");
    if (!menu || menu.hidden) return;
    const trigger = this.shadowRoot.querySelector('[aria-controls="' + CSS.escape(menu.id) + '"]');
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const index = items.indexOf(event.target);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      items[next]?.focus();
      return;
    }
    if (!["Escape", "Tab"].includes(event.key)) return;
    event.preventDefault();
    menu.hidden = true; trigger?.setAttribute("aria-expanded", "false"); trigger?.focus();
  }
  speakerPicker(selected = []) {
    const ids = [...new Set([...Object.keys(this.hass.states).filter(id => id.startsWith("media_player.")), ...selected])].sort((a, b) => this.speakerName(a).localeCompare(this.speakerName(b)));
    return '<fieldset class="choices"><legend>' + escape(this.t("speakers")) + "</legend>" + ids.map(id => '<label class="check"><input type="checkbox" name="speakers" value="' + escape(id) + '"' + checked(selected.includes(id)) + ">" + escape(this.speakerName(id)) + (this.available(id) ? "" : ' <span class="warning">' + escape(this.t(this.hass.states[id] ? "unavailable" : "missing")) + "</span>") + "</label>").join("") + "</fieldset>";
  }
  dayPicker(selected = []) { return '<fieldset class="choices"><legend>' + escape(this.t("days")) + "</legend>" + DAYS.map((day, index) => this.checkbox("weekdays", day, selected.includes(index), 'value="' + index + '"')).join("") + "</fieldset>"; }
  messageFields(source = { kind: "template", template: "" }) {
    return '<label class="field">' + escape(this.t("source")) + '<select name="kind"><option value="template">' + escape(this.t("direct")) + '</option><option value="message_set"' + (source.kind === "message_set" ? " selected" : "") + ">" + escape(this.t("random")) + '</option></select></label><label class="field" data-field="set"' + (source.kind === "message_set" ? "" : " hidden") + ">" + escape(this.t("chooseSet")) + '<select name="set_id"><option value="">' + escape(this.t("chooseSet")) + "</option>" + this.data.message_sets.map(s => '<option value="' + escape(s.id) + '"' + (s.id === source.set_id ? " selected" : "") + ">" + escape(s.name) + "</option>").join("") + '</select></label><label class="field">' + escape(this.t("message")) + '<textarea name="template" rows="4" required maxlength="10000">' + escape(source.template) + '</textarea></label><div class="actions">' + this.button("insert-time", "insertTime") + this.button("insert-random", "insertRandom") + '</div><p class="muted">' + escape(this.t("placeholders")) + "</p>";
  }
  variantFields(message) {
    return '<div class="variant" data-id="' + escape(message.id || "") + '"><label class="field">' + escape(this.t("variant")) + '<textarea name="variant" rows="2" required maxlength="10000">' + escape(message.text) + "</textarea></label>" + this.checkbox("variant-enabled", "enabled", message.enabled) + this.button("remove-variant", "remove") + "</div>";
  }
  settingsFields(settings) {
    const providers = [...new Set([...Object.keys(this.hass.states).filter(id => id.startsWith("tts.")), ...(settings.tts_entity_id ? [settings.tts_entity_id] : [])])];
    return '<label class="field">' + escape(this.t("provider")) + '<select name="provider">' + providers.map(id => '<option value="' + escape(id) + '"' + (settings.tts_service === "tts.speak" && id === settings.tts_entity_id ? " selected" : "") + ">" + escape(this.speakerName(id)) + "</option>").join("") + '<option value="legacy"' + (settings.tts_service !== "tts.speak" ? " selected" : "") + ">" + escape(this.t("legacy")) + '</option></select></label><div data-field="legacy"' + (settings.tts_service !== "tts.speak" ? "" : " hidden") + ">" + this.field("tts_service", "legacy", settings.tts_service) + "</div>" + this.field("language", "language", settings.language) + this.checkbox("cache_recurring_tts", "cache", settings.cache_recurring_tts) + '<label class="field">' + escape(this.t("chimes")) + '<textarea name="intro_urls" rows="3">' + escape(settings.intro_urls.join("\n")) + "</textarea></label>" + [["intro_delay", "introDelay", 0, 60], ["queue_hold_seconds", "hold", 0, 120], ["playback_timeout_seconds", "timeout", 10, 600], ["one_time_grace_seconds", "grace", 0, 3600]].map(([name, key, min, max]) => this.field(name, key, settings[name], "number", 'required min="' + min + '" max="' + max + '" step="1"')).join("");
  }
  currentRecord(editor = this.editor) {
    if (!editor) return null;
    if (editor.owner === "settings") return this.data;
    const collection = ["routine", "routine_meta"].includes(editor.owner) ? this.data.routines : editor.owner === "message_set" ? this.data.message_sets : this.data.bells;
    return collection.find(record => record.id === editor.id);
  }
  checkEditorRevision() {
    if (!this.editor || !this.dialog.open || this.editor.operation || !this.editor.id && this.editor.owner !== "settings") return;
    const current = this.currentRecord();
    const changed = !current || current.revision !== this.editor.revision || this.editor.timezone !== this.data.timezone;
    this.dialog.querySelector("#conflict").hidden = !changed;
  }
  showDialog(title, content, actions = "") {
    this.dialog.innerHTML = '<form><header><h2 id="dialog-title">' + escape(this.t(title)) + '</h2><span id="draft-status" role="status"></span></header><div id="editor-error" class="error" role="alert"></div><div id="conflict" class="warning" hidden>' + escape(this.t("changedElsewhere")) + " " + this.button("reload-editor", "reloadSaved") + '</div><fieldset id="editor-fields">' + content + '</fieldset><footer>' + this.button("cancel", "cancel") + (actions || '<button type="submit" class="primary">' + escape(this.t(this.editor.id || this.editor.owner === "settings" ? "save" : "create")) + "</button>") + "</footer></form>";
    this.dialog.setAttribute("aria-labelledby", "dialog-title");
    if (!this.dialog.open) this.dialog.showModal();
  }
  openEditor(owner, id = "", step = "", action = "edit") {
    if (this._busy) return;
    const reference = { owner, id };
    const base = this.currentRecord(reference);
    let item = clone(owner === "settings" ? this.data.settings : owner === "routine" ? base?.steps.find(s => s.id === step) || {} : base || {});
    if (action === "new" && owner !== "routine") item = {};
    if (action === "new" && ["weekly", "one_time", "routine"].includes(owner)) item.speakers = this.rememberedSpeakers();
    const duplicate = action === "duplicate";
    const rearm = action === "reschedule";
    this.editor = { owner, id: duplicate || action === "new" && owner !== "routine" ? "" : id, step, action, item, base: base ? clone(base) : null, revision: base?.revision, timezone: this.data.timezone, dirty: false, generation: 0, rearm };
    let fields = "";
    if (owner === "settings") fields = this.settingsFields(item);
    else if (owner === "routine_meta") fields = this.field("name", "routineName", item.name, "text", 'required maxlength="200"') + this.checkbox("enabled", "enabled", item.enabled || false);
    else if (owner === "message_set") fields = this.field("name", "name", item.name, "text", 'required maxlength="200"') + '<div id="variants">' + (item.messages || [{ text: "", enabled: true }]).map(m => this.variantFields(m)).join("") + "</div>" + this.button("add-variant", "addMessage");
    else {
      const date = owner === "one_time" && item.datetime && !duplicate && !rearm ? wallTime(item.datetime, this.data.timezone) : { date: tomorrow(this.data.timezone), time: item.time?.slice(0, 5) || "08:00" };
      fields = owner === "routine" ? this.field("name", "name", item.name, "text", 'maxlength="200"') : "";
      fields += '<p class="muted">' + escape(this.t("timezone")) + ": " + escape(this.data.timezone) + "</p>";
      if (owner === "one_time") fields += this.field("date", "date", date.date, "date", "required");
      if (owner === "weekly") fields += '<label class="field">' + escape(this.t("days")) + '<select name="weekday">' + DAYS.map((day, index) => '<option value="' + index + '"' + (index === (item.weekday ?? 0) ? " selected" : "") + ">" + escape(this.t(day)) + "</option>").join("") + "</select></label>";
      if (owner === "routine") fields += this.dayPicker(item.weekdays || [0, 1, 2, 3, 4]);
      fields += this.field("time", "time", owner === "one_time" ? date.time : item.time?.slice(0, 5) || "08:00", "time", 'required step="60"') + this.checkbox("enabled", "enabled", duplicate ? false : item.enabled || false) + this.messageFields(item.message_source) + this.speakerPicker(item.speakers);
    }
    this.showDialog(rearm ? "reschedule" : action === "new" || duplicate ? "create" : "edit", fields);
  }
  closeEditor(force = false) {
    if (this._busy) return false;
    if (!force && this.editor?.dirty && !window.confirm(this.t("discardQuestion"))) return false;
    this.dialog.close(); this.editor = null; return true;
  }
  setBusy(value) {
    this._busy = value;
    const fields = this.dialog.querySelector("#editor-fields"); if (fields) fields.disabled = value;
    this.dialog.querySelectorAll("footer button").forEach(button => { button.disabled = value || button.dataset.action === "commit-operation" && !this.editor?.preview; });
  }
  async saveEditor(form) {
    if (this._busy || !this.editor || !form.reportValidity()) return;
    const editor = this.editor;
    let speakersToRemember = [];
    const value = name => form.elements.namedItem(name)?.value || "";
    const isChecked = name => !!form.elements.namedItem(name)?.checked;
    const selections = name => [...form.querySelectorAll('input[name="' + name + '"]:checked')].map(input => input.value);
    try {
      if (editor.operation === "copy") {
        const weekdays = selections("weekdays").map(Number);
        if (!weekdays.length) throw Error(this.t("noDay"));
        this.setBusy(true);
        await this.mutate("copy", { bell_id: editor.id, weekdays });
      } else {
        if (editor.timezone !== this.data.timezone) throw Error(this.t("changedElsewhere"));
        let changes;
        let command, request;
        if (editor.owner === "settings") {
          changes = { tts_service: value("provider") === "legacy" ? value("tts_service") : "tts.speak", tts_entity_id: value("provider") === "legacy" ? "" : value("provider"), language: value("language"), cache_recurring_tts: isChecked("cache_recurring_tts"), intro_urls: value("intro_urls").split("\n").map(url => url.trim()).filter(Boolean) };
          for (const key of ["intro_delay", "queue_hold_seconds", "playback_timeout_seconds", "one_time_grace_seconds"]) changes[key] = Number(value(key));
          command = "settings"; request = { changes, expected_revision: editor.revision };
        } else if (editor.owner === "routine_meta") {
          changes = { name: value("name"), enabled: isChecked("enabled") };
          command = editor.id ? "routine/update" : "routine/create";
          request = editor.id ? { routine_id: editor.id, changes, expected_revision: editor.revision } : { routine: { ...changes, steps: [] } };
        } else if (editor.owner === "message_set") {
          changes = { name: value("name"), messages: [...form.querySelectorAll(".variant")].map(node => ({ ...(node.dataset.id ? { id: node.dataset.id } : {}), text: node.querySelector("textarea").value, enabled: node.querySelector('input[type="checkbox"]').checked })) };
          command = editor.id ? "message_set/update" : "message_set/create";
          request = editor.id ? { set_id: editor.id, changes, expected_revision: editor.revision } : { message_set: changes };
        } else {
          const speakers = selections("speakers"); if (!speakers.length) throw Error(this.t("noSpeaker"));
          speakersToRemember = speakers;
          const source = { kind: value("kind"), template: value("template") };
          if (source.kind === "message_set") source.set_id = value("set_id");
          changes = { enabled: isChecked("enabled"), message_source: source, speakers };
          if (editor.owner === "routine") {
            const weekdays = selections("weekdays").map(Number); if (!weekdays.length) throw Error(this.t("noDay"));
            const updated = { ...editor.item, ...changes, name: value("name"), time: value("time"), weekdays };
            const steps = editor.step ? editor.base.steps.map(s => s.id === editor.step ? updated : s) : [...editor.base.steps, updated];
            command = "routine/update"; request = { routine_id: editor.id, changes: { steps }, expected_revision: editor.revision };
          } else {
            changes.type = editor.owner;
            if (editor.owner === "one_time") {
              changes.datetime = eventDatetime(editor.id && !editor.rearm ? editor.item.datetime : null, value("date"), value("time"), editor.timezone);
              if (editor.rearm) changes.status = "pending";
            } else { changes.weekday = Number(value("weekday")); changes.time = value("time"); }
            command = editor.id ? "update" : "create";
            request = editor.id ? { bell_id: editor.id, changes, expected_revision: editor.revision } : { bell: changes };
          }
        }
        this.setBusy(true);
        await this.mutate(command, request);
        this.rememberSpeakers(speakersToRemember);
      }
      this.setBusy(false); this.closeEditor(true); this.announce(this.t("saved")); this.render();
    } catch (error) { this.editorError(error); }
    finally { this.setBusy(false); }
  }
  async exportBackup() {
    const backup = await this.call("export");
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "family-bell-" + wallTime(Date.now(), this.data.timezone).date + ".json"; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  openOperation(operation, id = "") {
    this.editor = { operation, id, dirty: false, generation: 0, preview: null };
    if (operation === "copy") { this.showDialog("copy", this.dayPicker([])); return; }
    let content;
    if (operation === "restore") content = '<p>' + escape(this.t("restoreWarning")) + "</p>" + this.button("export", "export") + this.field("file", "file", "", "file", 'accept=".json,application/json" required') + '<label class="field">' + escape(this.t("restore")) + '<select name="mode"><option value="merge">' + escape(this.t("merge")) + '</option><option value="replace">' + escape(this.t("replace")) + "</option></select></label>" + this.checkbox("include_settings", "includeSettings", false);
    else content = this.field("name", "routineName", "", "text", 'required maxlength="200"') + '<fieldset class="choices vertical"><legend>' + escape(this.t("selectRows")) + "</legend>" + this.data.bells.filter(b => b.type === "weekly").map(b => this.checkboxText("bell_ids", this.t(DAYS[b.weekday]) + " " + b.time.slice(0, 5) + " · " + friendlyTemplate(b.message_source.template), false, 'value="' + escape(b.id) + '"')).join("") + "</fieldset>";
    this.showDialog(operation === "restore" ? "restore" : "convert", content + '<div id="operation-preview" aria-live="polite"></div>', this.button("preview-operation", operation === "restore" ? "previewRestore" : "previewConvert") + this.button("commit-operation", operation === "restore" ? "confirmRestore" : "commitConvert", "disabled", true));
  }
  async previewOperation() {
    const editor = this.editor, form = this.dialog.querySelector("form");
    if (!form.reportValidity() || this._busy) return;
    this.setBusy(true);
    try {
      let request;
      if (editor.operation === "restore") {
        const file = form.elements.namedItem("file").files[0];
        if (!file || file.size > 5 * 1024 * 1024) throw Error(this.t("tooLarge"));
        request = { payload: JSON.parse(await file.text()), mode: form.elements.namedItem("mode").value, include_settings: form.elements.namedItem("include_settings").checked };
      } else request = { bell_ids: [...form.querySelectorAll('input[name="bell_ids"]:checked')].map(input => input.value), name: form.elements.namedItem("name").value };
      const result = await this.call(editor.operation === "restore" ? "restore/preview" : "conversion/preview", request);
      editor.preview = { request, result };
      const preview = this.dialog.querySelector("#operation-preview");
      if (editor.operation === "restore") preview.innerHTML = "<p>" + escape(this.t("counts", result.counts)) + "</p><p>" + escape(this.t(request.mode)) + "</p>";
      else preview.innerHTML = "<h3>" + escape(result.routine.name) + "</h3><ul>" + result.routine.steps.map(s => "<li>" + escape(s.time.slice(0, 5) + " · " + s.weekdays.map(day => this.t(DAYS[day])).join(", ") + " · " + friendlyTemplate(s.message_source.template)) + "</li>").join("") + "</ul>";
    } finally { this.setBusy(false); }
  }
  async commitOperation() {
    const editor = this.editor;
    if (!editor?.preview || this._busy || !window.confirm(this.t(editor.operation === "restore" ? "restoreQuestion" : "convertQuestion"))) return;
    this.setBusy(true);
    try {
      const { request, result } = editor.preview;
      await this.mutate(editor.operation === "restore" ? "restore/commit" : "conversion/commit", { ...request, ...(editor.operation === "restore" ? { fingerprint: result.fingerprint } : { expected_revision: result.revision }) });
      this.setBusy(false); this.closeEditor(true); this.announce(this.t(editor.operation === "restore" ? "restored" : "saved")); this.render();
    } finally { this.setBusy(false); }
  }
}

if (!customElements.get("ha-family-bell-panel")) customElements.define("ha-family-bell-panel", HaFamilyBellPanel);
