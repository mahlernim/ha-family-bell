# HA Family Bell

HA Family Bell is a HACS-installable Home Assistant custom integration for managing announcements as one weekly grid instead of many separate automations.

Every row is an independent bell. Editing a Monday row does **not** silently change a copied Tuesday row. “Copy to days” creates independent records that can be edited or deleted separately.

## What it provides

- Sidebar panel grouped Monday through Sunday
- One row per bell: active, day/date, time, message, speakers, and actions
- Single-time events with pending, completed, and missed states
- Add, edit, test, duplicate, copy to days, move to another day, and delete
- Integration-owned `.storage` data; no generated automation YAML
- Exact next-occurrence timers that are rebuilt after every edit and restart
- Master schedule switch and `sensor.ha_family_bell_next_bell`
- Speaker-aware queuing: bells sharing a speaker wait; disjoint speaker sets can run in parallel
- JSON export and safe import (all imported rows are forced disabled)
- Optional intro sound and configurable TTS service/language
- Home Assistant templates in message fields, including `now()` and random choices

## Safety behavior

The master schedule switch starts **off**. Newly added, duplicated, and imported rows also start off. This prevents duplicate announcements while an existing automation schedule is still active.

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
  "message": "Good morning. It is {{ now().strftime('%H:%M') }}.",
  "speakers": ["media_player.bedroom"]
}
```

`weekday` uses Monday `0` through Sunday `6`. A one-time bell uses `type: "one_time"` and an ISO `datetime` instead.

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
