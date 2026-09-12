"""Transactional schedules, cancellable jobs and speaker-aware playback."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from contextlib import AsyncExitStack, asynccontextmanager
from copy import deepcopy
from datetime import datetime, timedelta
from random import SystemRandom, choice
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

from homeassistant.components import persistent_notification
from homeassistant.core import CoreState, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError, TemplateError
from homeassistant.helpers.event import async_track_point_in_utc_time
from homeassistant.helpers.storage import Store
from homeassistant.helpers.template import Template
from homeassistant.util import dt as dt_util

from .const import (
    DEFAULT_SETTINGS,
    EVENT_FIRED,
    EVENT_UPDATED,
    PANEL_URL_PATH,
    STORE_KEY,
    STORE_VERSION,
)
from .schedule import (
    BellValidationError,
    advance_shuffle,
    build_conversion_preview,
    next_occurrence,
    next_weekday_occurrence,
    normalize_bell,
    normalize_message_set,
    normalize_routine,
    should_cache_tts,
    sort_key,
)

_LOGGER = logging.getLogger(__name__)
_RANDOM = SystemRandom()
_MAX_RECORDS = 2000


class FamilyBellStore(Store[dict[str, Any]]):
    """Retain the existing v2 store and migrate v1 without losing schedules."""

    async def async_save(self, data):
        # HA Store logs WriteError instead of raising it. Transactions must see
        # that failure and must not report success for a deferred shutdown write.
        if self.hass.state is CoreState.stopping:
            raise OSError("Home Assistant is stopping")
        self._write_error = None
        await super().async_save(data)
        if self._write_error is not None:
            raise OSError("Unable to persist Family Bell data") from self._write_error

    async def _async_write_data(self, data):
        try:
            await super()._async_write_data(data)
        except Exception as err:
            self._write_error = err
            raise

    async def _async_migrate_func(self, old_major_version, _old_minor_version, old_data):
        if old_major_version != 1:
            raise NotImplementedError
        return {**deepcopy(old_data), "routines": [], "message_sets": [], "random_state": {}}


class FamilyBellManager:
    """Own records and execution. Publish state only after a successful save."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.timezone = ZoneInfo(hass.config.time_zone)
        self._store = FamilyBellStore(hass, STORE_VERSION, STORE_KEY, atomic_writes=True)
        self._data: dict[str, Any] = {}
        self._mutation_lock = asyncio.Lock()
        self._timers: dict[str, dict[str, Any]] = {}
        self._speaker_locks: dict[str, asyncio.Lock] = {}
        self._jobs: dict[asyncio.Task, tuple[str, dict, bool]] = {}
        self._in_flight: set[str] = set()
        self._activity: dict[str, dict] = {}
        self._stopping = False
        self._started = False

    @staticmethod
    def empty_data() -> dict[str, Any]:
        return {
            "global_enabled": False,
            "settings": deepcopy(DEFAULT_SETTINGS),
            "bells": [],
            "routines": [],
            "message_sets": [],
            "random_state": {},
            "history": [],
            "pending_runs": [],
            "revision": 0,
        }

    @property
    def global_enabled(self) -> bool:
        return bool(self._data.get("global_enabled", False))

    @property
    def settings(self) -> dict[str, Any]:
        return deepcopy(self._data["settings"])

    async def async_initialize(
        self,
        *,
        start: bool = True,
        initial_settings: dict[str, Any] | None = None,
        require_saved_data: bool = False,
    ) -> None:
        loaded = await self._store.async_load()
        if loaded is None and require_saved_data:
            raise BellValidationError(
                "Saved Family Bell data is no longer available. Add the integration again "
                "to choose a speech provider, or restore its saved data."
            )
        data = {**self.empty_data(), **(loaded or {})}
        if loaded is None and initial_settings is not None:
            data["settings"] = {**data["settings"], **initial_settings}
        data["settings"] = self._normalize_settings(data["settings"], check_service=False)
        for collection in ("bells", "routines", "message_sets"):
            data[collection] = [self._normalize(collection, item) for item in data[collection]]
        # A persisted claim means an interrupted one-time attempt may have sent
        # audio. Do not replay it after a restart with an uncertain outcome.
        for bell in data["bells"]:
            if bell["id"] in data["pending_runs"] and bell["type"] == "one_time":
                bell["status"] = "missed"
        data["pending_runs"] = []
        self._validate_data(data)
        cancelled = await self._persist(data)
        self._data = data
        if cancelled:
            raise asyncio.CancelledError
        if start:
            await self.async_start()

    async def async_start(self, _hass=None) -> None:
        if self._stopping:
            return
        self._started = True
        async with self._change(bump=False):
            pass

    async def async_timezone_changed(self, _event=None) -> None:
        if self._stopping or self.timezone.key == self.hass.config.time_zone:
            return
        previous_timezone = self.timezone
        self.timezone = ZoneInfo(self.hass.config.time_zone)
        if not self._started:
            return
        affected = self._timezone_changed_events(previous_timezone, self.timezone)
        for task, (_key, _target, test) in list(self._jobs.items()):
            if not test and not task.cancelling():
                task.cancel()
        self._cancel_timers()
        self._reschedule_all()
        self._notify()
        if affected:
            self._notify_timezone_changed(affected, previous_timezone)

    async def async_shutdown(self, _event=None) -> None:
        self._stopping = True
        self._started = False
        self._cancel_timers()
        tasks = [task for task in self._jobs if task is not asyncio.current_task()]
        for task in tasks:
            if not task.cancelling():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        # Wait for any CRUD save already in progress before a new manager loads.
        async with self._mutation_lock:
            pass

    async def _persist(self, data):
        """Let an atomic executor write settle even when its caller is cancelled."""
        writer = asyncio.create_task(self._store.async_save(data))
        cancelled = False
        while not writer.done():
            try:
                await asyncio.shield(writer)
            except asyncio.CancelledError:
                cancelled = True
        writer.result()
        return cancelled

    @asynccontextmanager
    async def _change(self, *, bump: bool = True):
        async with self._mutation_lock:
            if self._stopping:
                raise BellValidationError(
                    "The integration is unloading. Try again after it reloads."
                )
            candidate = deepcopy(self._data)
            yield candidate
            self._expire_events(candidate)
            if bump:
                candidate["revision"] = self._data.get("revision", 0) + 1
            cancelled = await self._persist(candidate)
            self._data = candidate
            self._cancel_invalid_jobs()
            self._reschedule_all()
            self._notify()
            if cancelled:
                raise asyncio.CancelledError

    def _expire_events(self, data: dict) -> None:
        if not self._started or not data["global_enabled"]:
            return
        cutoff = dt_util.utcnow() - timedelta(seconds=data["settings"]["one_time_grace_seconds"])
        for bell in data["bells"]:
            if (
                bell["type"] == "one_time"
                and bell["status"] == "pending"
                and f"bell:{bell['id']}" not in self._in_flight
                and datetime.fromisoformat(bell["datetime"]) < cutoff
            ):
                bell["status"] = "missed"

    def _normalize(self, collection: str, raw: dict, *, fresh: bool = False) -> dict:
        if not isinstance(raw, dict):
            raise BellValidationError("Records must be objects")
        raw = deepcopy(raw)
        if fresh:
            raw["id"] = None
        normalizers = {
            "bells": lambda item: normalize_bell(item, self.timezone),
            "routines": normalize_routine,
            "message_sets": normalize_message_set,
        }
        result = normalizers[collection](raw)
        revision = 1 if fresh else raw.get("revision", 1)
        if type(revision) is not int or revision < 1:
            raise BellValidationError("Invalid record revision")
        result["revision"] = revision
        return result

    @staticmethod
    def _find(data: dict, collection: str, record_id: str) -> dict:
        for item in data[collection]:
            if item["id"] == record_id:
                return item
        raise BellValidationError("Record not found. Refresh the panel.")

    @staticmethod
    def _check_revision(record: dict, expected_revision: int | None) -> None:
        if expected_revision is not None and record.get("revision", 0) != expected_revision:
            raise BellValidationError(
                "This item changed elsewhere. Reload its saved version before saving."
            )

    def _validate_template(self, text: str) -> None:
        try:
            Template(text, self.hass).ensure_valid()
        except TemplateError as err:
            raise BellValidationError(f"Invalid message template: {err}") from err

    def _validate_data(self, data: dict) -> None:
        for collection in ("bells", "routines", "message_sets"):
            items = data[collection]
            if len(items) > _MAX_RECORDS:
                raise BellValidationError(f"Too many {collection}; limit is {_MAX_RECORDS}")
            ids = [item["id"] for item in items]
            if len(ids) != len(set(ids)):
                raise BellValidationError(f"Duplicate IDs in {collection}")
        valid_sets = {item["id"] for item in data["message_sets"]}
        for message_set in data["message_sets"]:
            for item in message_set["messages"]:
                self._validate_template(item["text"])
        targets = [
            *data["bells"],
            *(step for routine in data["routines"] for step in routine["steps"]),
        ]
        for target in targets:
            source = target["message_source"]
            self._validate_template(source["template"])
            if source["kind"] == "message_set":
                if source["set_id"] not in valid_sets:
                    raise BellValidationError("A referenced message set does not exist")
                if not re.search(
                    r"(?:{{|{%)[\s\S]*?\brandom_message\b[\s\S]*?(?:}}|%})", source["template"]
                ):
                    raise BellValidationError(
                        "Use the Random message placeholder in the linked template"
                    )

    def _normalize_settings(self, changes: dict, *, check_service: bool = True) -> dict:
        if not isinstance(changes, dict) or set(changes) - set(DEFAULT_SETTINGS):
            raise BellValidationError("Unknown announcement settings")
        settings = {**DEFAULT_SETTINGS, **changes}
        for field in ("tts_service", "tts_entity_id", "language"):
            if not isinstance(settings[field], str) or len(settings[field]) > 200:
                raise BellValidationError(f"Invalid {field}")
            settings[field] = settings[field].strip()
        if not re.fullmatch(r"tts\.[a-z0-9_]+", settings["tts_service"]):
            raise BellValidationError("Choose a TTS provider or a tts service")
        if settings["tts_service"] == "tts.speak":
            entity_id = settings["tts_entity_id"]
            if not re.fullmatch(r"tts\.[a-z0-9_]+", entity_id):
                raise BellValidationError("Choose a text-to-speech provider")
            if check_service and self.hass.states.get(entity_id) is None:
                raise BellValidationError("The selected TTS provider does not exist")
        if check_service and not self.hass.services.has_service(
            *settings["tts_service"].split(".", 1)
        ):
            raise BellValidationError("The selected TTS service is not available")
        if not isinstance(settings["cache_recurring_tts"], bool):
            raise BellValidationError("Cache must be true or false")
        for field, upper in (
            ("intro_delay", 60),
            ("queue_hold_seconds", 120),
            ("one_time_grace_seconds", 3600),
            ("playback_timeout_seconds", 600),
        ):
            if type(settings[field]) is not int or not 0 <= settings[field] <= upper:
                raise BellValidationError(f"{field} must be an integer from 0 to {upper}")
        if settings["playback_timeout_seconds"] < 10:
            raise BellValidationError("Playback timeout must be at least 10 seconds")
        urls = settings["intro_urls"]
        if (
            not isinstance(urls, list)
            or len(urls) > 100
            or any(not isinstance(url, str) or len(url) > 4096 for url in urls)
        ):
            raise BellValidationError("Chimes must contain at most 100 media paths or URLs")
        settings["intro_urls"] = [url.strip() for url in urls if url.strip()]
        return settings

    def snapshot(self) -> dict[str, Any]:
        return {
            "schema_version": STORE_VERSION,
            "revision": self._data.get("revision", 0),
            "global_enabled": self.global_enabled,
            "settings": self.settings,
            "bells": sorted(deepcopy(self._data["bells"]), key=sort_key),
            "routines": deepcopy(self._data["routines"]),
            "message_sets": deepcopy(self._data["message_sets"]),
            "routine_occurrences": self._routine_occurrences(),
            "history": deepcopy(self._data["history"][-50:]),
            "activity": deepcopy(list(self._activity.values())),
            "next_bell": self.next_bell(),
            "timezone": self.timezone.key,
        }

    def export_data(self) -> dict:
        return {
            "version": 2,
            "timezone": self.timezone.key,
            "settings": self.settings,
            **{key: deepcopy(self._data[key]) for key in ("bells", "routines", "message_sets")},
        }

    def _routine_occurrences(self) -> list[dict]:
        return sorted(
            [
                {
                    "routine_id": routine["id"],
                    "routine_name": routine["name"],
                    "step_id": step["id"],
                    "step_name": step["name"],
                    "enabled": routine["enabled"] and step["enabled"],
                    "weekday": day,
                    "time": step["time"],
                    "message_source": deepcopy(step["message_source"]),
                    "speakers": list(step["speakers"]),
                }
                for routine in self._data["routines"]
                for step in routine["steps"]
                for day in step["weekdays"]
            ],
            key=lambda row: (row["weekday"], row["time"], row["routine_name"]),
        )

    def _targets(self) -> dict[str, dict]:
        targets = {f"bell:{bell['id']}": deepcopy(bell) for bell in self._data["bells"]}
        for routine in self._data["routines"]:
            for step in routine["steps"]:
                targets[f"routine:{routine['id']}:{step['id']}"] = {
                    **deepcopy(step),
                    "id": f"{routine['id']}:{step['id']}",
                    "type": "routine",
                    "routine_id": routine["id"],
                    "routine_name": routine["name"],
                    "step_id": step["id"],
                    "routine_enabled": routine["enabled"],
                }
        return targets

    def _target(self, key: str) -> dict | None:
        """Return one detached target without building the complete target map."""
        if key.startswith("bell:"):
            bell_id = key.removeprefix("bell:")
            bell = next((item for item in self._data["bells"] if item["id"] == bell_id), None)
            return deepcopy(bell) if bell is not None else None
        if not key.startswith("routine:"):
            return None
        try:
            routine_id, step_id = key.removeprefix("routine:").split(":", 1)
        except ValueError:
            return None
        routine = next((item for item in self._data["routines"] if item["id"] == routine_id), None)
        if routine is None:
            return None
        step = next((item for item in routine["steps"] if item["id"] == step_id), None)
        if step is None:
            return None
        return {
            **deepcopy(step),
            "id": f"{routine['id']}:{step['id']}",
            "type": "routine",
            "routine_id": routine["id"],
            "routine_name": routine["name"],
            "step_id": step["id"],
            "routine_enabled": routine["enabled"],
        }

    def _occurrence(self, target: dict, now: datetime) -> datetime | None:
        if not target["enabled"] or not target.get("routine_enabled", True):
            return None
        if target["type"] == "one_time" and target["id"] in self._data["pending_runs"]:
            return None
        if target["type"] == "routine":
            return next_weekday_occurrence(target["weekdays"], target["time"], now, self.timezone)
        occurrence = next_occurrence(target, now, self.timezone)
        if target["type"] == "one_time" and target["status"] == "pending" and occurrence is None:
            age = (now - datetime.fromisoformat(target["datetime"])).total_seconds()
            if 0 <= age <= self._data["settings"]["one_time_grace_seconds"]:
                return now + timedelta(seconds=1)
        return occurrence

    def next_bell(self) -> dict | None:
        if not self.global_enabled or self._stopping:
            return None
        now = dt_util.utcnow()
        candidates = [
            (self._occurrence(target, now), target)
            for key, target in self._targets().items()
            if key not in self._in_flight
        ]
        candidates = [(at, target) for at, target in candidates if at is not None]
        if not candidates:
            return None
        at, target = min(candidates, key=lambda pair: pair[0])
        return {"bell": target, "occurrence": at.isoformat()}

    async def async_set_global_enabled(self, enabled: bool) -> None:
        if not isinstance(enabled, bool):
            raise BellValidationError("Enabled must be true or false")
        async with self._change() as data:
            data["global_enabled"] = enabled

    async def async_update_settings(self, changes: dict, expected_revision=None) -> dict:
        async with self._change() as data:
            self._check_revision(data, expected_revision)
            data["settings"] = self._normalize_settings({**data["settings"], **changes})
        return self.settings

    async def _create(self, collection: str, raw: dict) -> dict:
        item = self._normalize(collection, raw, fresh=True)
        async with self._change() as data:
            data[collection].append(item)
            self._validate_data(data)
        return deepcopy(item)

    async def async_create(self, raw: dict) -> dict:
        return await self._create("bells", {"enabled": False, **raw})

    async def async_create_routine(self, raw: dict) -> dict:
        return await self._create("routines", raw)

    async def async_create_message_set(self, raw: dict) -> dict:
        return await self._create("message_sets", raw)

    async def _update(self, collection, record_id, changes, expected_revision=None) -> dict:
        async with self._change() as data:
            current = self._find(data, collection, record_id)
            self._check_revision(current, expected_revision)
            item = self._normalize(
                collection,
                {**current, **changes, "id": record_id, "revision": current["revision"] + 1},
            )
            if (
                collection == "bells"
                and current["type"] == "one_time"
                and item["type"] == "one_time"
                and changes.get("status") == "pending"
                and current["status"] != "pending"
                and (
                    item["datetime"] == current["datetime"]
                    or datetime.fromisoformat(item["datetime"]) <= dt_util.utcnow()
                )
            ):
                raise BellValidationError(
                    "Choose a new future time to reschedule a completed event"
                )
            if (
                collection == "bells"
                and record_id in data["pending_runs"]
                and item.get("datetime") != current.get("datetime")
            ):
                if (
                    item["type"] == "one_time"
                    and datetime.fromisoformat(item["datetime"]) <= dt_util.utcnow()
                ):
                    raise BellValidationError(
                        "Choose a new future time to retry an interrupted event"
                    )
                data["pending_runs"].remove(record_id)
            data[collection][data[collection].index(current)] = item
            self._validate_data(data)
            if collection == "message_sets":
                self._prune_random_state(data, item)
        return deepcopy(item)

    async def async_update(self, bell_id, changes, expected_revision=None):
        return await self._update("bells", bell_id, changes, expected_revision)

    async def async_update_routine(self, routine_id, changes, expected_revision=None):
        return await self._update("routines", routine_id, changes, expected_revision)

    async def async_update_message_set(self, set_id, changes, expected_revision=None):
        return await self._update("message_sets", set_id, changes, expected_revision)

    async def async_patch_steps(self, routine_id: str, *, step_id=None, enabled: bool) -> dict:
        """Patch current steps under the same lock; never replace a stale client array."""
        if not isinstance(enabled, bool):
            raise BellValidationError("Enabled must be true or false")
        async with self._change() as data:
            routine = self._find(data, "routines", routine_id)
            steps = [step for step in routine["steps"] if step_id is None or step["id"] == step_id]
            if step_id is not None and not steps:
                raise BellValidationError("Routine bell not found")
            for step in steps:
                step["enabled"] = enabled
            routine["revision"] += 1
        return deepcopy(routine)

    async def _delete(self, collection, record_id, expected_revision=None) -> None:
        async with self._change() as data:
            current = self._find(data, collection, record_id)
            self._check_revision(current, expected_revision)
            if collection == "message_sets":
                bell_refs, step_refs = self._message_set_reference_counts(data, record_id)
                references = bell_refs + step_refs
                if references:
                    parts = []
                    if bell_refs:
                        parts.append(f"{bell_refs} bell{'s' if bell_refs != 1 else ''}")
                    if step_refs:
                        parts.append(f"{step_refs} routine step{'s' if step_refs != 1 else ''}")
                    raise BellValidationError(
                        f"Message set is in use by {references} record{'s' if references != 1 else ''} "
                        f"({' and '.join(parts)})."
                    )
            data[collection].remove(current)
            self._validate_data(data)
            if collection == "message_sets":
                data["random_state"].pop(record_id, None)

    async def async_delete(self, bell_id, expected_revision=None):
        await self._delete("bells", bell_id, expected_revision)

    async def async_delete_finished_events(self, expected_revision: int) -> dict:
        async with self._change() as data:
            self._check_revision(data, expected_revision)
            deleted_ids = {
                bell["id"]
                for bell in data["bells"]
                if bell["type"] == "one_time" and bell["status"] in {"completed", "missed"}
            }
            data["bells"] = [bell for bell in data["bells"] if bell["id"] not in deleted_ids]
            data["pending_runs"] = [
                bell_id for bell_id in data["pending_runs"] if bell_id not in deleted_ids
            ]
            self._validate_data(data)
        return {"deleted": len(deleted_ids)}

    async def async_delete_routine(self, routine_id, expected_revision=None):
        await self._delete("routines", routine_id, expected_revision)

    async def async_delete_message_set(self, set_id, expected_revision=None):
        await self._delete("message_sets", set_id, expected_revision)

    async def async_copy(self, bell_id, weekdays):
        async with self._change() as data:
            source = self._find(data, "bells", bell_id)
            if source["type"] != "weekly":
                raise BellValidationError("Only weekly bells can be copied")
            created = [
                self._normalize("bells", {**source, "enabled": False, "weekday": day}, fresh=True)
                for day in sorted(set(weekdays))
            ]
            data["bells"].extend(created)
            self._validate_data(data)
        return deepcopy(created)

    async def async_import(self, raw_bells):
        async with self._change() as data:
            created = [
                self._normalize("bells", {**raw, "enabled": False}, fresh=True) for raw in raw_bells
            ]
            data["bells"].extend(created)
            self._validate_data(data)
        return deepcopy(created)

    def _restore_candidate(self, payload, mode, include_settings):
        if not isinstance(payload, dict) or payload.get("version") not in (1, 2):
            raise BellValidationError("Unsupported backup version")
        if mode not in ("merge", "replace"):
            raise BellValidationError("Choose merge or replace")
        timezone = payload.get("timezone", self.timezone.key)
        try:
            ZoneInfo(timezone)
        except (KeyError, TypeError, ValueError) as err:
            raise BellValidationError("Invalid backup time zone") from err
        if timezone != self.timezone.key:
            raise BellValidationError(
                "Backup time zone differs from Home Assistant. Convert its times before importing."
            )
        data = deepcopy(self._data)
        if mode == "replace":
            for collection in ("bells", "routines", "message_sets"):
                data[collection] = []
            data["random_state"] = {}
            data["pending_runs"] = []
            data["global_enabled"] = False
        records = {}
        for collection in ("bells", "routines", "message_sets"):
            raw = payload.get(collection, [])
            if not isinstance(raw, list) or len(raw) > _MAX_RECORDS:
                raise BellValidationError("Invalid or oversized backup")
            records[collection] = [self._normalize(collection, item) for item in raw]
        self._validate_data({**self.empty_data(), **records})
        mapping = {item["id"]: str(uuid4()) for item in records["message_sets"]}
        for item in records["message_sets"]:
            item["id"] = mapping[item["id"]]
            item["revision"] = 1
            for message in item["messages"]:
                message["id"] = str(uuid4())
        for collection in ("bells", "routines"):
            for item in records[collection]:
                item.update(id=str(uuid4()), enabled=False, revision=1)
                targets = item["steps"] if collection == "routines" else [item]
                for target in targets:
                    if collection == "routines":
                        target.update(id=str(uuid4()), enabled=False)
                    source = target["message_source"]
                    if source["kind"] == "message_set":
                        source["set_id"] = mapping[source["set_id"]]
        for collection, items in records.items():
            data[collection].extend(items)
        if include_settings:
            if "settings" not in payload:
                raise BellValidationError("This backup does not contain announcement settings")
            data["settings"] = self._normalize_settings(payload["settings"], check_service=False)
        self._validate_data(data)
        return data, {collection: len(items) for collection, items in records.items()}

    def _restore_fingerprint(self, payload, mode, include_settings):
        value = json.dumps(
            [payload, mode, include_settings, self._data.get("revision", 0)], sort_keys=True
        )
        return hashlib.sha256(value.encode()).hexdigest()

    def restore_preview(self, payload, mode="merge", include_settings=False):
        _candidate, counts = self._restore_candidate(payload, mode, include_settings)
        return {
            "counts": counts,
            "mode": mode,
            "settings": include_settings,
            "fingerprint": self._restore_fingerprint(payload, mode, include_settings),
            "all_imported_disabled": True,
            "schedule_paused": mode == "replace",
        }

    async def async_restore(self, payload, mode, include_settings, fingerprint):
        async with self._change() as data:
            if fingerprint != self._restore_fingerprint(payload, mode, include_settings):
                raise BellValidationError("The schedule changed. Preview the restore again.")
            candidate, counts = self._restore_candidate(payload, mode, include_settings)
            data.clear()
            data.update(candidate)
        return counts

    def conversion_preview(self, bell_ids, name="Morning Routine"):
        return {
            **build_conversion_preview(self._data["bells"], bell_ids, name),
            "revision": self._data.get("revision", 0),
        }

    async def async_commit_conversion(
        self, bell_ids, name="Morning Routine", expected_revision=None
    ):
        async with self._change() as data:
            self._check_revision(data, expected_revision)
            preview = build_conversion_preview(data["bells"], bell_ids, name)
            created_sets = [
                self._normalize("message_sets", item, fresh=True)
                for item in preview["message_sets"]
            ]
            mapping = {
                raw["key"]: item["id"]
                for raw, item in zip(preview["message_sets"], created_sets, strict=True)
            }
            steps = deepcopy(preview["routine"]["steps"])
            for step in steps:
                if key := step["message_source"].pop("set_key", None):
                    step["message_source"]["set_id"] = mapping[key]
            routine = self._normalize(
                "routines", {**preview["routine"], "steps": steps}, fresh=True
            )
            data["bells"] = [item for item in data["bells"] if item["id"] not in bell_ids]
            data["message_sets"].extend(created_sets)
            data["routines"].append(routine)
            self._validate_data(data)
        return {"routine": routine, "message_sets": created_sets}

    def _cancel_timers(self):
        for timer in self._timers.values():
            timer["cancel"]()
        self._timers.clear()

    def _reschedule_all(self):
        if not self._started or self._stopping or not self.global_enabled:
            self._cancel_timers()
            return
        targets = self._targets()
        for key in list(self._timers):
            if targets.get(key) != self._timers[key]["target"]:
                self._timers.pop(key)["cancel"]()
        now = dt_util.utcnow()
        for key, target in targets.items():
            # Preserve unchanged pending callbacks, including simultaneous due bells.
            if key in self._timers or key in self._in_flight:
                continue
            occurrence = self._occurrence(target, now)
            if occurrence is None:
                continue
            token = str(uuid4())

            @callback
            def fire(_now, key=key, token=token):
                timer = self._timers.get(key)
                if self._stopping or timer is None or timer["token"] != token:
                    return
                self.hass.async_create_task(self._async_timer_fired(key, token))

            cancel = async_track_point_in_utc_time(self.hass, fire, occurrence)
            self._timers[key] = {"cancel": cancel, "target": target, "token": token}

    def _allowed(self, key, target, test):
        if self._stopping:
            return False
        if test:
            return True
        current = self._target(key)
        return (
            self.global_enabled
            and current == target
            and target["enabled"]
            and target.get("routine_enabled", True)
        )

    @staticmethod
    def _message_set_reference_counts(data: dict, set_id: str) -> tuple[int, int]:
        def references(item: dict) -> bool:
            source = item.get("message_source", {})
            return source.get("kind") == "message_set" and source.get("set_id") == set_id

        return (
            sum(references(bell) for bell in data["bells"]),
            sum(references(step) for routine in data["routines"] for step in routine["steps"]),
        )

    def _timezone_changed_events(
        self, old_timezone: ZoneInfo, new_timezone: ZoneInfo
    ) -> list[dict]:
        affected = []
        for bell in self._data["bells"]:
            if bell["type"] != "one_time" or bell["status"] != "pending":
                continue
            instant = datetime.fromisoformat(bell["datetime"])
            old_display = instant.astimezone(old_timezone).strftime("%Y-%m-%d %H:%M")
            new_display = instant.astimezone(new_timezone).strftime("%Y-%m-%d %H:%M")
            if old_display != new_display:
                affected.append({"old": old_display, "new": new_display})
        return affected

    def _notify_timezone_changed(self, affected: list[dict], previous_timezone: ZoneInfo) -> None:
        korean = self.hass.config.language.lower().startswith("ko")
        shown = affected[:5]
        changes = "\n".join(f"- {item['old']} → {item['new']}" for item in shown)
        remaining = len(affected) - len(shown)
        if korean:
            title = "Family Bell 시간대 변경"
            message = (
                f"시간대가 {previous_timezone.key}에서 {self.timezone.key}(으)로 변경되었습니다. "
                f"예정된 일회성 알림 {len(affected)}개의 실제 시각은 유지되며 표시 시각만 바뀝니다.\n\n"
                f"{changes}"
                + (f"\n- 외 {remaining}개" if remaining else "")
                + f"\n\n[Family Bell 열기](/{PANEL_URL_PATH})"
            )
        else:
            title = "Family Bell timezone changed"
            message = (
                f"The timezone changed from {previous_timezone.key} to {self.timezone.key}. "
                f"{len(affected)} pending one-time event(s) keep the same instant, but their displayed "
                f"local time changed.\n\n{changes}"
                + (f"\n- and {remaining} more" if remaining else "")
                + f"\n\n[Open Family Bell](/{PANEL_URL_PATH})"
            )
        persistent_notification.async_create(
            self.hass,
            message,
            title=title,
            notification_id="ha_family_bell_timezone_changed",
        )

    def _cancel_invalid_jobs(self):
        for task, (key, target, test) in list(self._jobs.items()):
            if (
                task is not asyncio.current_task()
                and not task.cancelling()
                and not self._allowed(key, target, test)
            ):
                task.cancel()

    def _assert_allowed(self, key, target, test):
        if not self._allowed(key, target, test):
            raise asyncio.CancelledError

    async def _async_timer_fired(self, key, token):
        timer = self._timers.get(key)
        if self._stopping or timer is None or timer["token"] != token or key in self._in_flight:
            return
        self._timers.pop(key)
        self._in_flight.add(key)
        try:
            await self._run_target(key, timer["target"], test=False)
        finally:
            self._in_flight.discard(key)
            if not self._stopping:
                self._reschedule_all()
                self._notify()

    async def async_test(self, bell_id):
        key = f"routine:{bell_id}" if ":" in bell_id else f"bell:{bell_id}"
        target = self._targets().get(key)
        if target is None:
            raise BellValidationError("Bell not found")
        return await self._run_target(key, target, test=True)

    async def async_test_routine_step(self, routine_id, step_id):
        return await self.async_test(f"{routine_id}:{step_id}")

    @staticmethod
    def _prune_random_state(data, message_set):
        state = data["random_state"].get(message_set["id"])
        if state is None:
            return
        enabled = {item["id"] for item in message_set["messages"] if item["enabled"]}
        state["remaining"] = [item for item in state.get("remaining", []) if item in enabled]
        if state.get("last") not in enabled:
            state["last"] = None

    def _render_message(self, data, target):
        source = target["message_source"]
        variables = None
        if source["kind"] == "message_set":
            message_set = self._find(data, "message_sets", source["set_id"])
            messages = {
                item["id"]: item["text"] for item in message_set["messages"] if item["enabled"]
            }
            state = data["random_state"].setdefault(
                source["set_id"], {"remaining": [], "last": None}
            )
            selected = advance_shuffle(list(messages), state, _RANDOM.shuffle)
            variables = {
                "random_message": str(
                    Template(messages[selected], self.hass).async_render(parse_result=False)
                )
            }
        text = str(
            Template(source["template"], self.hass).async_render(variables, parse_result=False)
        ).strip()
        if not text:
            raise BellValidationError("The rendered message is empty")
        return text

    def _set_activity(self, job_id, target, status, test):
        self._activity[job_id] = {
            "bell_id": target["id"],
            "routine_name": target.get("routine_name"),
            "status": status,
            "speakers": list(target["speakers"]),
            "test": test,
        }
        self._notify()

    async def _run_target(self, key, target, *, test):
        if self._stopping:
            raise BellValidationError("The integration is unloading")
        task = asyncio.current_task()
        self._jobs[task] = (key, target, test)
        job_id = str(uuid4())
        result = {
            "bell_id": target["id"],
            "routine_id": target.get("routine_id"),
            "step_id": target.get("step_id"),
            "test": test,
            "fired_at": dt_util.utcnow().isoformat(),
            "status": "failed",
            "speakers": [],
            "speaker_results": {},
            "message": "",
        }
        self._set_activity(job_id, target, "queued", test)
        cancelled = False
        try:
            async with AsyncExitStack() as stack:
                for entity_id in sorted(target["speakers"]):
                    await stack.enter_async_context(
                        self._speaker_locks.setdefault(entity_id, asyncio.Lock())
                    )
                self._assert_allowed(key, target, test)
                available = []
                for entity_id in target["speakers"]:
                    state = self.hass.states.get(entity_id)
                    if state is None or state.state in {"unknown", "unavailable"}:
                        result["speaker_results"][entity_id] = "unavailable"
                    else:
                        available.append(entity_id)
                if not available:
                    raise BellValidationError("No selected speaker is available")
                if test:
                    result["message"] = self._render_message(deepcopy(self._data), target)
                else:
                    async with self._change(bump=False) as data:
                        self._assert_allowed(key, target, test)
                        result["message"] = self._render_message(data, target)
                        if target["type"] == "one_time":
                            data["pending_runs"].append(target["id"])
                settings = self._normalize_settings(self.settings)
                self._set_activity(job_id, target, "sending", test)
                chime = choice(settings["intro_urls"]) if settings["intro_urls"] else None

                async def send(entity_id):
                    self._assert_allowed(key, target, test)
                    before = self.hass.states.get(entity_id)
                    try:
                        if chime:
                            await self.hass.services.async_call(
                                "media_player",
                                "play_media",
                                {
                                    "entity_id": entity_id,
                                    "media_content_id": chime,
                                    "media_content_type": "music",
                                },
                                blocking=True,
                            )
                            await asyncio.sleep(settings["intro_delay"])
                        self._assert_allowed(key, target, test)
                        payload = {
                            "message": result["message"],
                            "cache": should_cache_tts(
                                target["type"],
                                test=test,
                                recurring_cache=settings["cache_recurring_tts"],
                            ),
                        }
                        if settings["language"]:
                            payload["language"] = settings["language"]
                        if settings["tts_service"] == "tts.speak":
                            payload.update(
                                entity_id=settings["tts_entity_id"],
                                media_player_entity_id=entity_id,
                            )
                        else:
                            payload["entity_id"] = entity_id
                        await self.hass.services.async_call(
                            *settings["tts_service"].split(".", 1), payload, blocking=True
                        )
                        result["speaker_results"][entity_id] = "sent"
                        result["speakers"].append(entity_id)
                        await self._wait_playback(entity_id, before, result["message"], settings)
                    except Exception:
                        result["speaker_results"][entity_id] = "failed"
                        _LOGGER.exception("Family Bell playback request failed for %s", entity_id)

                async with asyncio.TaskGroup() as group:
                    for entity_id in available:
                        group.create_task(send(entity_id))
                result["status"] = "sent" if result["speakers"] else "failed"
                if result["speakers"] and len(result["speakers"]) < len(target["speakers"]):
                    result["status"] = "partial"
                if not result["speakers"]:
                    result["error"] = (
                        "Playback requests failed. Check the TTS provider and speakers."
                    )
        except asyncio.CancelledError:
            cancelled = True
            result["status"] = "cancelled"
            result["error"] = "Cancelled because the schedule changed or the integration stopped."
        except (HomeAssistantError, BellValidationError, OSError) as err:
            result["error"] = (
                str(err)
                if isinstance(err, BellValidationError)
                else "Announcement failed. Check Home Assistant logs."
            )
            _LOGGER.warning("Family Bell execution failed (%s)", type(err).__name__)
        except Exception:
            result["error"] = "Announcement failed. Check Home Assistant logs."
            _LOGGER.exception("Unexpected Family Bell execution failure")
        finally:
            self._activity.pop(job_id, None)
            if not self._stopping:
                try:
                    async with self._change(bump=False) as data:
                        if not test and target["type"] == "one_time":
                            data["pending_runs"] = [
                                item for item in data["pending_runs"] if item != target["id"]
                            ]
                            current = next(
                                (item for item in data["bells"] if item["id"] == target["id"]), None
                            )
                            if (
                                current
                                and current["type"] == "one_time"
                                and datetime.fromisoformat(current["datetime"])
                                == datetime.fromisoformat(target["datetime"])
                            ):
                                current["status"] = "completed" if result["speakers"] else "missed"
                        data["history"] = [*data["history"][-99:], result]
                    self.hass.bus.async_fire(EVENT_FIRED, deepcopy(result))
                except (OSError, HomeAssistantError, BellValidationError):
                    _LOGGER.exception("Unable to persist Family Bell outcome")
            self._jobs.pop(task, None)
        if cancelled:
            raise asyncio.CancelledError
        if test and not result["speakers"]:
            raise BellValidationError(result.get("error", "No selected speaker is available"))
        return result

    async def _wait_playback(self, entity_id, before, message, settings):
        """Use fresh player feedback when available; bound uncertain playback waits."""
        loop = asyncio.get_running_loop()
        start = loop.time()
        fallback = max(
            settings["queue_hold_seconds"], len(message.split()) / 2.0, len(message) / 7.0
        )
        timeout = settings["playback_timeout_seconds"]
        seen_playing = False
        while loop.time() - start < timeout:
            elapsed = loop.time() - start
            state = self.hass.states.get(entity_id)
            fresh = state is not None and (
                before is None or state.last_updated > before.last_updated
            )
            if fresh and state.state in {"playing", "buffering"}:
                seen_playing = True
            if (
                elapsed >= settings["queue_hold_seconds"]
                and seen_playing
                and state
                and state.state not in {"playing", "buffering"}
            ):
                return
            if not seen_playing and elapsed >= fallback:
                return
            await asyncio.sleep(min(0.5, max(0.01, timeout - elapsed)))

    def _notify(self):
        if not self._stopping:
            self.hass.bus.async_fire(EVENT_UPDATED)
