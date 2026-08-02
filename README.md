# HA Family Bell

HA Family Bell is a Home Assistant custom integration for scheduling spoken
announcements. It brings weekly bells, reusable routines, one-time events,
message variation, chimes, and speaker selection into a single panel.

> **Project status:** Beta. The integration is available through a HACS custom
> repository and is not currently included in the default HACS catalog.

## Highlights

- Compact week preview combining weekly bells and routine occurrences
- Weekly announcements with exact local times and speaker selection
- Reusable routines with independent times, weekdays, messages, and speakers
- One-time announcements with pending, completed, and missed states
- Message sets that rotate enabled variants without repeating until every
  variant has been used
- Direct Home Assistant templates or linked message sets for every bell type
- Friendly `%time%` and `%randomset%` placeholders for common messages
- Optional fixed or randomly selected chime files
- Optional Home Assistant TTS caching for recurring announcements
- Speaker-aware queuing to reduce overlapping playback
- Master schedule switch and `sensor.ha_family_bell_next_bell`
- JSON export and safety-focused import

## Documentation

- [User guide](docs/user-guide.md) — installation, setup, everyday use, and
  troubleshooting
- [Report a problem](https://github.com/mahlernim/ha-family-bell/issues)

## Installation

### HACS custom repository

1. In HACS, open **Integrations** and add this repository as a custom
   repository with the **Integration** category.
2. Install **HA Family Bell** and restart Home Assistant.
3. Go to **Settings → Devices & services → Add integration**.
4. Search for **HA Family Bell** and complete the setup.
5. Open **HA Family Bell** from the sidebar.

For first-time configuration and examples, continue with the
[user guide](docs/user-guide.md).

### Manual installation

Copy `custom_components/ha_family_bell` to the `custom_components` directory in
your Home Assistant configuration, restart Home Assistant, and add the
integration from **Settings → Devices & services**.

## How scheduling works

The panel separates scheduling into four areas:

- **Weekly Schedule** contains independent recurring announcements.
- **Routines** group related recurring announcements under one switch.
- **Single-time Events** contain announcements that run once at a specific
  date and time.
- **Message Sets** contain reusable message variants shared by linked bells.

**Week Preview** is a read-only overview. It expands routines into their weekly
occurrences without creating duplicate schedule records. Source colors and Edit
buttons identify where each announcement is managed.

Three levels can control a routine announcement: the main schedule switch, the
routine switch, and the individual bell switch. All three must be enabled for
the announcement to run. Changing the routine switch also applies the same
enabled state to every bell inside that routine.

## Message placeholders

The editor provides two readable placeholders for common Home Assistant
templates:

- `%time%` inserts the current Home Assistant local time as `HH:MM`.
- `%randomset%` inserts the next enabled variant from the linked message set.

For example:

```text
Good morning. It is %time%. %randomset%
```

Advanced Home Assistant Jinja templates remain supported. Common Jinja values
are displayed as friendly placeholders in the editor when possible.

## Announcement settings

- **TTS service** defaults to `tts.google_translate_say`. The selected service
  must accept the legacy `entity_id`, `message`, `language`, and `cache` service
  data used by the integration.
- **Language** defaults to `en-gb`.
- **Cache recurring announcements** asks Home Assistant to reuse generated
  speech for scheduled weekly and routine announcements. One-time events and
  manual tests bypass the cache.
- **Chime files** accepts one media ID, local path, or URL per line. One entry
  is used for every announcement; multiple entries are selected randomly; an
  empty list disables the chime.
- **Chime-to-speech delay** controls the pause between chime playback and TTS.
- **Queue hold** adds a minimum speaker lock after an announcement is sent.

## Safety and recovery behavior

- The main schedule switch and newly added bells start disabled.
- Imported bells are always disabled and must be reviewed before activation.
- Conversion tools show a preview and require confirmation before replacing
  selected weekly bells.
- A conversion does not enable, disable, or remove Home Assistant automations.
- Weekly bells missed while Home Assistant is offline wait for their next
  scheduled occurrence.
- A recently due one-time event may run after restart within the built-in grace
  period. Older events are marked `missed`.
- Unavailable speakers are skipped. A one-time event is marked `missed` if no
  selected speaker is available or the announcement fails.

## Data and migration

HA Family Bell stores its schedule in Home Assistant `.storage`; it does not
generate automation YAML. Version 1 schedules migrate to the current data model
without converting direct messages into routines or message sets.

Use **Export JSON** before a large edit or migration. Imported rows are created
disabled so that times, messages, and speakers can be reviewed before use.

## Development

```bash
python -m pip install .[test] ruff
ruff format --check .
ruff check .
pytest
node --check custom_components/ha_family_bell/frontend/ha-family-bell-panel.js
```

Before publishing a release, also run Hassfest and HACS validation from GitHub
Actions or an equivalent Linux environment.
