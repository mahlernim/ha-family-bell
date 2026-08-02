# HA Family Bell User Guide

This guide explains how to install, configure, and use HA Family Bell. The
integration manages spoken announcements inside Home Assistant without
creating automation YAML.

## Contents

1. [Install the integration](#install-the-integration)
2. [Complete the first setup](#complete-the-first-setup)
3. [Understand the schedule controls](#understand-the-schedule-controls)
4. [Create a weekly bell](#create-a-weekly-bell)
5. [Create and manage a routine](#create-and-manage-a-routine)
6. [Create a message set](#create-a-message-set)
7. [Use message placeholders](#use-message-placeholders)
8. [Create a one-time event](#create-a-one-time-event)
9. [Configure chimes and TTS](#configure-chimes-and-tts)
10. [Use Week Preview](#use-week-preview)
11. [Import or convert an existing schedule](#import-or-convert-an-existing-schedule)
12. [Back up and restore schedule data](#back-up-and-restore-schedule-data)
13. [Troubleshoot announcements](#troubleshoot-announcements)

## Install the integration

### Install with HACS

1. Open HACS in Home Assistant.
2. Open **Integrations**.
3. Add `https://github.com/mahlernim/ha-family-bell` as a custom repository
   with the **Integration** category.
4. Search for **HA Family Bell** and select **Download**.
5. Restart Home Assistant when HACS requests it.
6. Go to **Settings → Devices & services → Add integration**.
7. Search for **HA Family Bell** and complete the setup.

### Install manually

1. Download the repository.
2. Copy `custom_components/ha_family_bell` into the `custom_components`
   directory in your Home Assistant configuration.
3. Restart Home Assistant.
4. Add **HA Family Bell** from **Settings → Devices & services**.

Only one HA Family Bell integration instance can be configured.

## Complete the first setup

1. Open **HA Family Bell** from the Home Assistant sidebar.
2. Expand **Announcement settings**.
3. Confirm the TTS service and language.
4. Optionally add one or more chime files.
5. Create a test bell and select one or more media-player speakers.
6. Use the bell's **Test** button to confirm chime and speech playback.
7. Enable the bell.
8. Turn on **Schedule active** only after the schedule has been reviewed.

Testing a bell plays it immediately. It does not change its scheduled time or
consume the live sequence of a linked message set.

## Understand the schedule controls

The **Schedule active** switch is the main safety control. No scheduled bell
can run while it is off.

A weekly bell runs when both of these controls are on:

- Schedule active
- The bell's Active checkbox

A routine bell runs only when all three controls are on:

- Schedule active
- Routine active
- The bell's Active checkbox

Changing **Routine active** also applies the same enabled state to every bell in
that routine. Turning it off disables the nested bells; turning it on enables
them.

## Create a weekly bell

Use a weekly bell for an independent announcement that repeats on one weekday.

1. Open **Weekly Schedule**.
2. Find the required weekday and select **Add bell**.
3. Enter the exact local time.
4. Choose a direct message or a linked message set.
5. Select one or more speakers.
6. Save the bell.
7. Test it before enabling it.

Weekly bells can be duplicated, copied to other weekdays, or moved to another
weekday. Copies remain independent; editing one copy does not change another.

## Create and manage a routine

Use a routine for a group of related recurring announcements, such as a morning
sequence, medication reminders, study prompts, or closing-time notices.

1. Open **Routines**.
2. Select **New routine**.
3. Enter a descriptive routine name.
4. Add a bell to the routine.
5. Choose its time and one or more weekdays.
6. Enter a message or select a message set.
7. Select the speakers and save.
8. Repeat for each announcement in the routine.

Use **Routine active** to pause or resume the whole routine. **All on** and
**All off** change every individual bell in that routine and save immediately.
They do not affect other routines or independent weekly bells.

Routine occurrences appear in **Week Preview**, but routine bells are edited
only from **Routines**.

## Create a message set

Message sets provide variation while keeping message management in one place.

1. Open **Message Sets**.
2. Select **New message set**.
3. Enter a clear name.
4. Add two or more message variants.
5. Enable the variants that may be announced.
6. Save the set.
7. Link the set from a weekly bell, routine bell, or one-time event.

Enabled variants use a shuffle bag: every enabled variant is selected once
before the set is reshuffled. The sequence is shared by every bell linked to
that set and is preserved across Home Assistant restarts.

Editing a message set immediately affects every linked bell. A set that is in
use cannot be deleted until its linked bells are changed. A set containing one
enabled variant is valid and always returns that variant.

## Use message placeholders

HA Family Bell supports readable placeholders for the two most common dynamic
values:

- `%time%` — current Home Assistant local time in `HH:MM` format
- `%randomset%` — next message from the linked message set

Example using a direct message:

```text
The time is %time%. Please prepare for the next activity.
```

Example using a linked message set:

```text
Good morning. It is %time%. %randomset%
```

Use the **Time** and **Random message** buttons to insert placeholders. The
Random message placeholder is available only when the bell uses a message set.

Advanced Jinja templates are also supported. If a template is not recognized
as a friendly placeholder, the original Jinja expression remains unchanged.

## Create a one-time event

Use a one-time event for an announcement that should run once on a specific
date and time.

1. Open **Single-time Events**.
2. Select **Add event**.
3. Choose the local date and time.
4. Enter a message or select a message set.
5. Select the speakers.
6. Save and enable the event.

Event states are:

- `pending` — waiting for its scheduled time
- `completed` — successfully sent to at least one selected speaker
- `missed` — too old to recover, no selected speaker was available, or the
  announcement failed

One-time events bypass TTS caching so dynamic message content is generated at
the time of the event.

## Configure chimes and TTS

Open **Announcement settings** from the top of the panel.

### TTS service

The default is `tts.google_translate_say`. The configured service must accept
the legacy service-data fields used by HA Family Bell: `entity_id`, `message`,
`language`, and `cache`.

### Language

Enter the language code supported by the selected TTS service, such as `en-gb`
or `en-us`.

### Chime files

Enter one media ID, local path, or URL per line:

```text
/local/media/chime.m4a
```

- One entry uses the same chime for every announcement.
- Multiple entries select a chime randomly for each announcement.
- An empty field disables chime playback.

The Home Assistant host and each selected speaker must be able to access the
configured media location. Use **Chime-to-speech delay** to allow the chime to
finish before TTS begins.

### Recurring TTS cache

When **Cache recurring announcements** is enabled, scheduled weekly and routine
bells request Home Assistant's TTS cache. Disable it when you want every
recurring announcement to request newly generated speech.

Manual tests and one-time events always bypass the cache.

### Queue hold

Queue hold adds a minimum speaker lock after the TTS request. Bells sharing a
speaker wait for one another, while bells using separate speakers may run at
the same time.

## Use Week Preview

**Week Preview** is a read-only summary of the active schedule. It combines
weekly bells with expanded routine occurrences and groups them by weekday.

Each row shows:

- time
- source schedule or routine
- message or linked set
- selected speakers
- enabled state
- an Edit shortcut to the owning section

Source colors distinguish independent weekly bells, individual routines, and
one-time events. Use **Enabled only** to hide disabled recurring items.

A conflict warning appears when two bells share both the same exact time and at
least one speaker. The warning helps with schedule review; speaker queuing still
prevents both announcements from playing through that speaker simultaneously.

## Import or convert an existing schedule

### Import JSON

1. Export or prepare a JSON schedule.
2. Select **Import disabled JSON**.
3. Review the number of imported bells.
4. Confirm the import.
5. Check every date or weekday, time, message, and speaker.
6. Test representative bells before enabling them.

All imported bells are disabled automatically.

### Convert weekly bells to a routine

The Morning Routine conversion tool groups similar weekly bells into a named
routine. Despite its default name and time window, the resulting routine is a
normal editable routine.

1. Open **Weekly Schedule** and select **Create Morning Routine**.
2. Adjust the candidate time window if needed.
3. Clear any weekly bells that should not be converted.
4. Enter the routine name.
5. Select **Preview conversion**.
6. Review the proposed bells, weekdays, messages, speakers, and message sets.
7. Confirm only when the preview is correct.

The conversion replaces only the selected weekly bells. It does not change the
main schedule switch or enable, disable, or remove Home Assistant automations.

If another automation system currently sends the same announcements, keep HA
Family Bell paused while reviewing and testing the converted schedule. Disable
the old announcements only when you are ready to switch systems, then observe
at least one scheduled HA Family Bell announcement before deleting old rules.

## Back up and restore schedule data

Select **Export JSON** before a large edit, conversion, or upgrade. Store the
download in a safe location.

To restore standalone bells from an export, select **Import disabled JSON**.
Imports add disabled weekly and one-time bells for review; they do not silently
replace the complete stored schedule. The export also contains routines and
message sets for backup and inspection, but the current import action does not
restore those objects automatically.

## Troubleshoot announcements

### Nothing plays at the scheduled time

Check the following in order:

1. **Schedule active** is on.
2. The weekly bell or one-time event is enabled.
3. For routine bells, **Routine active** and the individual bell are enabled.
4. The selected media players exist and are available.
5. The Home Assistant system time zone is correct.
6. The configured TTS service exists and supports the required service data.
7. The bell's **Test** action succeeds.

### The chime plays but speech does not

Test the configured TTS service from Home Assistant **Developer Tools →
Actions**. Confirm that the language code is supported and that the selected
speaker accepts TTS playback.

### Speech starts before the chime finishes

Increase **Chime-to-speech delay**. The integration does not automatically know
the exact duration of every media file.

### A dynamic recurring message sounds stale

Disable **Cache recurring announcements**, save the settings, and test again.
One-time events and manual tests are already uncached.

### A message set repeats unexpectedly

Confirm that more than one variant is enabled. Manual tests and previews do not
advance the live shuffle sequence, but scheduled bells linked to the same set
share one sequence.

### A one-time event is marked missed

The event may have expired beyond the restart grace period, all selected
speakers may have been unavailable, or the announcement action may have failed.
Review Home Assistant logs for `ha_family_bell` entries.

### Getting support

When opening an issue, include:

- HA Family Bell version
- Home Assistant version
- TTS integration and service name
- the affected bell type
- relevant `ha_family_bell` log entries with private URLs, entity names, and
  message content removed

Report issues at
[github.com/mahlernim/ha-family-bell/issues](https://github.com/mahlernim/ha-family-bell/issues).
