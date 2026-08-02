# HA Family Bell

HA Family Bell is a HACS-installable Home Assistant custom integration for managing weekly announcements, reusable routines, random-message sets, and single-time events in one place.

Standalone weekly rows remain independent. Routine steps can cover several weekdays, and linked message sets intentionally propagate edits to every bell or routine step that uses them.

## What it provides

- Week Preview opens by default with a compact Monday-to-Sunday view of weekly bells and routine steps
- Sidebar panel with Week Preview, Weekly Schedule, Routines, Single-time Events, and Message Sets tabs
- One row per bell: active, day/date, time, message, speakers, and actions
- Named routines with exact-time steps and weekday selection per step
- Explicit routine master switch plus immediate Enable all bells and Disable all bells controls
- Reusable random-message sets with enabled variants and persisted shuffle-without-repeats
- Direct Jinja templates or linked message sets for every bell type
- Weekly Schedule contains only editable standalone weekly bells; routine steps stay in Routines
- Color-coded owner badges, enabled state, speaker-overlap conflict warnings, and owner-aware Edit links
- Guided morning conversion that previews grouped steps and extracted literal random lists before committing
- Single-time events with pending, completed, and missed states
- Add, edit, test, duplicate, copy to days, move to another day, and delete
- Integration-owned `.storage` data; no generated automation YAML
- Exact next-occurrence timers that are rebuilt after every edit and restart
- Master schedule switch and `sensor.ha_family_bell_next_bell`
- Speaker-aware queuing: bells sharing a speaker wait; disjoint speaker sets can run in parallel
- JSON export and safe import (all imported rows are forced disabled)
- Optional intro sound and configurable TTS service/language
- Home Assistant templates in direct messages, set variants, and linked wrappers

## Safety behavior

The master schedule switch starts **off**. Newly added bells and routine steps also start off. The v1-to-v2 upgrade preserves the master, row, and one-time-event states and does not modify legacy Home Assistant automations.

The conversion wizard performs a read-only preview first. Its commit replaces only the explicitly selected weekly rows and leaves the master switch unchanged.

At restart, expired single-time events within the configured grace period are run; older events become `missed`. Weekly bells that passed while Home Assistant was offline wait until their next weekly occurrence.

Unavailable speakers are skipped. A one-time event becomes `missed` when no target is available or its announcement action fails. Weekly bells always schedule their next occurrence even after a failed execution.

## Installation

### HACS custom repository

1. In HACS, open **Integrations** and add this repository as a custom repository of type **Integration**.
2. Install **HA Family Bell** and restart Home Assistant.
3. Go to **Settings → Devices & services → Add integration**, search for **HA Family Bell**, and add it.
4. Open **HA Family Bell** in the sidebar. Configure announcement settings and add or import bells.
5. Test selected rows, then enable rows and finally turn on the master schedule switch.

### Manual development install

Copy `custom_components/ha_family_bell` into the Home Assistant `custom_components` directory, restart, and add the integration from the UI.

## Announcement settings

- **TTS service** defaults to `tts.google_translate_say` and accepts any `domain.service` using the legacy `entity_id` plus `message` shape.
- **Language** defaults to `en-gb`.
- **Intro URLs** are optional media URLs, one per line. One is chosen randomly for each bell.
- **Intro delay** waits between the intro and speech.
- **Minimum queue hold** keeps a speaker lock after TTS submission. The manager also estimates speech duration from word count, reducing overlap between bells that share a speaker.

TTS services with a different service-data schema are not yet supported by the grid settings.

## Data model

Weekly bell:

```json
{
  "type": "weekly",
  "weekday": 0,
  "time": "08:05:00",
  "enabled": true,
  "message_source": {
    "kind": "template",
    "template": "Good morning. It is {{ now().strftime('%H:%M') }}."
  },
  "speakers": ["media_player.bedroom"]
}
```

`weekday` uses Monday `0` through Sunday `6`. A one-time bell uses `type: "one_time"` and an ISO `datetime` instead. Existing v1 `message` strings migrate losslessly to direct template sources.

A linked source uses a stable message-set ID and a wrapper containing `random_message`:

```json
{
  "kind": "message_set",
  "set_id": "set-uuid",
  "template": "It is {{ now().strftime('%H:%M') }}. {{ random_message }}"
}
```

The chosen set variant is rendered as a Home Assistant template first, then supplied to the wrapper as `random_message`. Manual tests do not advance the persisted shuffle bag.

### Friendly message placeholders

The panel hides common Jinja expressions behind readable placeholders:

- `%time%` inserts the current Home Assistant local time as `HH:MM`.
- `%randomset%` inserts the next shuffled message from the selected message set.

For example, enter `Boys, it's %time%! %randomset%`. The editor shows a live example and provides **Time** and **Random message** insertion buttons. Existing Jinja values display as friendly placeholders automatically, while other advanced Jinja expressions remain unchanged and supported.

## Morning Routine conversion

From **Weekly Schedule**, select **Create Morning Routine**. The default 05:00–11:59 window identifies candidates, while checkboxes let you exclude individual rows. Preview groups equivalent time/message/speaker rows and merges their weekdays. A single literal Jinja expression such as `{{ ['First', 'Second'] | random }}` becomes a linked set; complex expressions stay as direct templates.

The final replacement requires a separate confirmation. Keep legacy automations active while the new schedule remains paused, test representative routine steps, and perform the automation cutover separately.

## Week Preview

**Week Preview** is the default read-only overview. It combines standalone weekly bells and expanded routine steps into compact Monday-to-Sunday lists without duplicating schedule records. The simplified grid shows time, source, message/set, speakers, state, and Edit. Each weekly/routine owner has a stable distinct source color, and **Edit** jumps to that source's owning tab. An optional filter hides disabled items.

Rows at the same day and exact time are marked **Conflict** when they share at least one speaker. This is a review warning only; the scheduler's speaker lock still prevents overlapping playback. Pending single-time events appear in a separate section below the recurring week.

## Routine controls

**Routine active** is the routine-level master switch: turning it off pauses every bell in that routine while preserving the individual step choices. **Enable all bells** and **Disable all bells** immediately save the corresponding enabled state to every step in that routine. They do not affect other routines or the global schedule switch.

## Migration workflow

Keep the existing automations active while reviewing imported rows:

1. Import JSON; imported rows are forced off.
2. Confirm row count, day, time, message, and speakers.
3. Configure intro/TTS settings and test a few representative rows.
4. Pause the old automations.
5. Enable the reviewed rows and the HA Family Bell master switch.
6. Observe at least one scheduled announcement before removing old automations.

For private migrations, keep the exported or generated file under a name matching `private-import*.json`; those files are intentionally Git-ignored.

## Development

```bash
python -m pip install .[test] ruff
ruff format --check .
ruff check .
pytest
node --check custom_components/ha_family_bell/frontend/ha-family-bell-panel.js
```

Before a release, also run Hassfest and HACS validation from a GitHub Actions workflow or equivalent Linux environment.
