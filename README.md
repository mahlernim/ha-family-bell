<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="custom_components/ha_family_bell/brand/dark_logo@2x.png">
    <img src="custom_components/ha_family_bell/brand/logo@2x.png" alt="HA Family Bell" width="620">
  </picture>
</p>

<p align="center">
  A single Home Assistant panel for weekly announcements, reusable routines, and one-time reminders.
</p>

<p align="center">
  <a href="https://github.com/mahlernim/ha-family-bell/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/mahlernim/ha-family-bell"></a>
  <img alt="Home Assistant 2026.7 or newer" src="https://img.shields.io/badge/Home%20Assistant-2026.7%2B-18BCF2?logo=home-assistant&logoColor=white">
  <img alt="HACS custom repository" src="https://img.shields.io/badge/HACS-Custom-41BDF5?logo=home-assistant-community-store&logoColor=white">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/mahlernim/ha-family-bell"></a>
</p>

<p align="center">
  <a href="https://my.home-assistant.io/redirect/hacs_repository/?owner=mahlernim&repository=ha-family-bell&category=integration">
    <img src="https://my.home-assistant.io/badges/hacs_repository.svg" alt="Open this repository in HACS">
  </a>
</p>

![HA Family Bell week preview](docs/images/panel-preview.png)

HA Family Bell organizes spoken announcements without requiring a separate
Home Assistant automation for every bell. Build a simple weekly schedule,
group related bells into routines, reuse rotating messages, and review the
entire week from one compact preview.

## Features

- Weekly bells with minute-based scheduling and per-bell speaker selection
- Reusable routines controlled by one switch or by individual bells
- One-time events for date-specific announcements
- Message sets that rotate enabled messages without repeating a message until
  the current cycle is complete
- Readable `%time%` and `%randomset%` placeholders, with advanced Jinja
  templates still supported
- Optional chime files and recurring TTS caching
- Compact week preview with source colors and conflict warnings
- Master schedule switch, next-bell sensor, speaker-aware queuing, and safe JSON
  export/import

## Installation

### HACS

1. Select the **Open this repository in HACS** button above, or add this
   repository to HACS as a custom **Integration** repository.
2. Download **HA Family Bell**.
3. Restart Home Assistant.
4. Go to **Settings → Devices & services → Add integration**.
5. Search for **HA Family Bell** and complete the setup.

HA Family Bell requires Home Assistant 2026.7 or newer.

### Manual installation

Copy `custom_components/ha_family_bell` into the `custom_components` directory
in your Home Assistant configuration, restart Home Assistant, and add the
integration from **Settings → Devices & services**.

## Quick start

1. Open **HA Family Bell** from the Home Assistant sidebar.
2. Expand **Announcement settings** and confirm the TTS service and language.
3. Add a weekly bell or routine bell, choose at least one speaker, and save it.
4. Use the play button to confirm the announcement sounds correct.
5. Enable the bell and turn on **Schedule active** when the schedule is ready.

New bells and imported bells start disabled so they can be reviewed before
they announce.

## How the schedule is organized

- **Week Preview** combines weekly bells, routine occurrences, and upcoming
  one-time events in a read-only overview.
- **Weekly Schedule** contains independent bells that repeat on one weekday.
- **Routines** group related recurring bells under a shared switch.
- **Single-time Events** run once on a selected date and time.
- **Message Sets** keep reusable message variations in one place. Editing a set
  updates every bell linked to it.

All times use the Home Assistant time zone and minute precision. If an older
schedule contains seconds, HA Family Bell safely normalizes them to the start
of that minute.

## Messages and chimes

Use `%time%` to insert the current local time and `%randomset%` to insert the
next enabled message from a linked set:

```text
Good morning. It is %time%. %randomset%
```

Announcement settings also accept one chime path, media ID, or URL per line.
One entry is used consistently; multiple entries are selected at random; an
empty list disables the chime.

## Documentation and support

- [User guide](docs/user-guide.md) — complete setup, usage, backup, and
  troubleshooting instructions
- [Report a problem](https://github.com/mahlernim/ha-family-bell/issues)

When reporting a problem, remove private entity names, message text, and media
URLs from logs or screenshots.

## License

HA Family Bell is available under the [MIT License](LICENSE).
