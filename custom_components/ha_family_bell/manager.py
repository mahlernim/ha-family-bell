"""Persistent schedule manager and exact-time executor."""

from __future__ import annotations

import asyncio
import logging
from contextlib import AsyncExitStack, suppress
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from random import SystemRandom, choice
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_point_in_utc_time
from homeassistant.helpers.storage import Store
from homeassistant.helpers.template import Template
from homeassistant.util import dt as dt_util

from .const import DEFAULT_SETTINGS, EVENT_FIRED, EVENT_UPDATED, STORE_KEY, STORE_VERSION
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


class FamilyBellStore(Store[dict[str, Any]]):
    """Versioned Family Bell store with lossless v1 migration."""

    async def _async_migrate_func(
        self, old_major_version: int, _old_minor_version: int, old_data: dict[str, Any]
    ) -> dict[str, Any]:
        if old_major_version != 1:
            raise NotImplementedError
        migrated = deepcopy(old_data)
        migrated.setdefault("routines", [])
        migrated.setdefault("message_sets", [])
        migrated.setdefault("random_state", {})
        return migrated


class FamilyBellManager:
    """Own persisted records, timers, and bell execution."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.timezone = ZoneInfo(hass.config.time_zone)
        self._store = FamilyBellStore(hass, STORE_VERSION, STORE_KEY, atomic_writes=True)
        self._data: dict[str, Any] = {}
        self._timers: dict[str, Any] = {}
        self._speaker_locks: dict[str, asyncio.Lock] = {}
        self._in_flight: set[str] = set()
        self._generation = 0
        self._mutation_lock = asyncio.Lock()

    @property
    def global_enabled(self) -> bool:
        return bool(self._data.get("global_enabled", False))

    @property
    def settings(self) -> dict[str, Any]:
        return deepcopy(self._data["settings"])

    async def async_initialize(self) -> None:
        """Load, normalize, and schedule persisted state."""
        loaded = await self._store.async_load()
        self._data = loaded or {
            "global_enabled": False,
            "settings": deepcopy(DEFAULT_SETTINGS),
            "bells": [],
            "routines": [],
            "message_sets": [],
            "random_state": {},
            "history": [],
        }
        self._data.setdefault("global_enabled", False)
        self._data["settings"] = {**DEFAULT_SETTINGS, **self._data.get("settings", {})}
        self._data["bells"] = [
            normalize_bell(item, self.timezone, bell_id=str(item["id"]))
            for item in self._data.get("bells", [])
        ]
        self._data["message_sets"] = [
            normalize_message_set(item, set_id=str(item["id"]))
            for item in self._data.get("message_sets", [])
        ]
        self._data["routines"] = [
            normalize_routine(item, routine_id=str(item["id"]))
            for item in self._data.get("routines", [])
        ]
        self._data.setdefault("random_state", {})
        self._data.setdefault("history", [])
        self._validate_all_references()
        await self._store.async_save(self._data)
        await self._async_reschedule_all()

    async def async_shutdown(self) -> None:
        self._cancel_all()

    def snapshot(self) -> dict[str, Any]:
        """Return frontend-safe data, excluding internal shuffle state."""
        return {
            "schema_version": STORE_VERSION,
            "global_enabled": self.global_enabled,
            "settings": self.settings,
            "bells": sorted((deepcopy(item) for item in self._data["bells"]), key=sort_key),
            "routines": deepcopy(self._data["routines"]),
            "message_sets": deepcopy(self._data["message_sets"]),
            "routine_occurrences": self._routine_occurrences(),
            "history": deepcopy(self._data["history"][-50:]),
            "next_bell": self.next_bell(),
            "timezone": self.timezone.key,
        }

    def _routine_occurrences(self) -> list[dict[str, Any]]:
        rows = []
        for routine in self._data["routines"]:
            for step in routine["steps"]:
                for weekday in step["weekdays"]:
                    rows.append(
                        {
                            "routine_id": routine["id"],
                            "routine_name": routine["name"],
                            "step_id": step["id"],
                            "step_name": step["name"],
                            "enabled": routine["enabled"] and step["enabled"],
                            "weekday": weekday,
                            "time": step["time"],
                            "message_source": deepcopy(step["message_source"]),
                            "speakers": deepcopy(step["speakers"]),
                        }
                    )
        return sorted(rows, key=lambda row: (row["weekday"], row["time"], row["routine_name"]))

    def _scheduled_targets(self) -> list[tuple[str, dict[str, Any], datetime | None]]:
        now = dt_util.utcnow()
        targets = []
        for bell in self._data["bells"]:
            targets.append((f"bell:{bell['id']}", bell, next_occurrence(bell, now, self.timezone)))
        for routine in self._data["routines"]:
            if not routine["enabled"]:
                continue
            for step in routine["steps"]:
                target = {
                    **step,
                    "id": f"{routine['id']}:{step['id']}",
                    "type": "routine",
                    "routine_id": routine["id"],
                    "routine_name": routine["name"],
                    "step_id": step["id"],
                    "step_name": step["name"],
                }
                occurrence = None
                if step["enabled"]:
                    occurrence = next_weekday_occurrence(
                        step["weekdays"], step["time"], now, self.timezone
                    )
                targets.append((f"routine:{routine['id']}:{step['id']}", target, occurrence))
        return targets

    def next_bell(self) -> dict[str, Any] | None:
        if not self.global_enabled:
            return None
        candidates = [item for item in self._scheduled_targets() if item[2] is not None]
        if not candidates:
            return None
        _key, target, occurrence = min(candidates, key=lambda item: item[2])
        return {"bell": deepcopy(target), "occurrence": occurrence.isoformat()}

    async def async_set_global_enabled(self, enabled: bool) -> None:
        async with self._mutation_lock:
            self._data["global_enabled"] = bool(enabled)
            await self._persist_and_reschedule()

    async def async_update_settings(self, changes: dict[str, Any]) -> None:
        allowed = {
            "tts_service",
            "language",
            "cache_recurring_tts",
            "intro_urls",
            "intro_delay",
            "queue_hold_seconds",
            "one_time_grace_seconds",
        }
        if unknown := set(changes) - allowed:
            raise BellValidationError(f"unknown settings: {', '.join(sorted(unknown))}")
        settings = {**self._data["settings"], **changes}
        service = str(settings["tts_service"]).strip()
        if "." not in service:
            raise BellValidationError("tts_service must be domain.service")
        settings["tts_service"] = service
        settings["language"] = str(settings["language"]).strip()
        settings["cache_recurring_tts"] = bool(settings["cache_recurring_tts"])
        if not isinstance(settings["intro_urls"], list):
            raise BellValidationError("intro_urls must be a list")
        settings["intro_urls"] = [
            str(item).strip() for item in settings["intro_urls"] if str(item).strip()
        ]
        settings["intro_delay"] = max(0, min(60, int(settings["intro_delay"])))
        settings["queue_hold_seconds"] = max(0, min(120, int(settings["queue_hold_seconds"])))
        settings["one_time_grace_seconds"] = max(
            0, min(3600, int(settings["one_time_grace_seconds"]))
        )
        async with self._mutation_lock:
            self._data["settings"] = settings
            await self._persist_and_notify()

    async def async_create(self, raw: dict[str, Any]) -> dict[str, Any]:
        bell = normalize_bell(raw, self.timezone)
        async with self._mutation_lock:
            self._validate_source(bell["message_source"])
            self._data["bells"].append(bell)
            await self._persist_and_reschedule()
        return deepcopy(bell)

    async def async_update(self, bell_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        async with self._mutation_lock:
            current = self._find_bell(bell_id)
            bell = normalize_bell(
                {**current, **changes, "id": bell_id}, self.timezone, bell_id=bell_id
            )
            self._validate_source(bell["message_source"])
            self._data["bells"][self._bell_index(bell_id)] = bell
            await self._persist_and_reschedule()
        return deepcopy(bell)

    async def async_delete(self, bell_id: str) -> None:
        async with self._mutation_lock:
            self._data["bells"].pop(self._bell_index(bell_id))
            await self._persist_and_reschedule()

    async def async_copy(self, bell_id: str, weekdays: list[int]) -> list[dict[str, Any]]:
        source = self._find_bell(bell_id)
        if source["type"] != "weekly":
            raise BellValidationError("only weekly bells can be copied to weekdays")
        created = []
        async with self._mutation_lock:
            for weekday in sorted(set(weekdays)):
                bell = normalize_bell({**source, "id": None, "weekday": weekday}, self.timezone)
                self._data["bells"].append(bell)
                created.append(deepcopy(bell))
            await self._persist_and_reschedule()
        return created

    async def async_import(self, raw_bells: list[dict[str, Any]]) -> list[dict[str, Any]]:
        imported = [
            normalize_bell({**raw, "id": None, "enabled": False}, self.timezone)
            for raw in raw_bells
        ]
        async with self._mutation_lock:
            for bell in imported:
                self._validate_source(bell["message_source"])
            self._data["bells"].extend(imported)
            await self._persist_and_reschedule()
        return deepcopy(imported)

    async def async_test(self, bell_id: str) -> None:
        await self._async_execute(deepcopy(self._find_bell(bell_id)), test=True)
        await self._store.async_save(self._data)

    async def async_create_routine(self, raw: dict[str, Any]) -> dict[str, Any]:
        routine = normalize_routine(raw)
        async with self._mutation_lock:
            self._validate_routine_sources(routine)
            self._data["routines"].append(routine)
            await self._persist_and_reschedule()
        return deepcopy(routine)

    async def async_update_routine(
        self, routine_id: str, changes: dict[str, Any]
    ) -> dict[str, Any]:
        async with self._mutation_lock:
            current = self._find_routine(routine_id)
            routine = normalize_routine(
                {**current, **changes, "id": routine_id}, routine_id=routine_id
            )
            self._validate_routine_sources(routine)
            self._data["routines"][self._routine_index(routine_id)] = routine
            await self._persist_and_reschedule()
        return deepcopy(routine)

    async def async_delete_routine(self, routine_id: str) -> None:
        async with self._mutation_lock:
            self._data["routines"].pop(self._routine_index(routine_id))
            await self._persist_and_reschedule()

    async def async_test_routine_step(self, routine_id: str, step_id: str) -> None:
        routine = self._find_routine(routine_id)
        try:
            step = next(item for item in routine["steps"] if item["id"] == step_id)
        except StopIteration as err:
            raise BellValidationError("routine step not found") from err
        target = {
            **deepcopy(step),
            "id": f"{routine_id}:{step_id}",
            "type": "routine",
            "routine_id": routine_id,
            "routine_name": routine["name"],
            "step_id": step_id,
            "step_name": step["name"],
        }
        await self._async_execute(target, test=True)
        await self._store.async_save(self._data)

    async def async_create_message_set(self, raw: dict[str, Any]) -> dict[str, Any]:
        message_set = normalize_message_set(raw)
        async with self._mutation_lock:
            self._data["message_sets"].append(message_set)
            await self._persist_and_notify()
        return deepcopy(message_set)

    async def async_update_message_set(
        self, set_id: str, changes: dict[str, Any]
    ) -> dict[str, Any]:
        async with self._mutation_lock:
            current = self._find_message_set(set_id)
            message_set = normalize_message_set({**current, **changes, "id": set_id}, set_id=set_id)
            self._data["message_sets"][self._message_set_index(set_id)] = message_set
            self._prune_random_state(message_set)
            await self._persist_and_notify()
        return deepcopy(message_set)

    async def async_delete_message_set(self, set_id: str) -> None:
        async with self._mutation_lock:
            references = self._message_set_references(set_id)
            if references:
                raise BellValidationError(f"message set is used by {', '.join(references[:5])}")
            self._data["message_sets"].pop(self._message_set_index(set_id))
            self._data["random_state"].pop(set_id, None)
            await self._persist_and_notify()

    def conversion_preview(
        self, bell_ids: list[str], name: str = "Morning Routine"
    ) -> dict[str, Any]:
        return build_conversion_preview(self._data["bells"], bell_ids, name)

    async def async_commit_conversion(
        self, bell_ids: list[str], name: str = "Morning Routine"
    ) -> dict[str, Any]:
        """Atomically replace selected weekly bells with a routine and new sets."""
        async with self._mutation_lock:
            preview = build_conversion_preview(self._data["bells"], bell_ids, name)
            created_sets = []
            key_to_id = {}
            for proposed in preview["message_sets"]:
                message_set = normalize_message_set(proposed)
                key_to_id[proposed["key"]] = message_set["id"]
                created_sets.append(message_set)
            raw_steps = []
            for step in preview["routine"]["steps"]:
                source = deepcopy(step["message_source"])
                if set_key := source.pop("set_key", None):
                    source["set_id"] = key_to_id[set_key]
                raw_steps.append({**step, "id": None, "message_source": source})
            routine = normalize_routine({**preview["routine"], "steps": raw_steps})
            available_set_ids = {
                item["id"] for item in [*self._data["message_sets"], *created_sets]
            }
            self._validate_routine_sources(routine, available_set_ids)
            source_ids = set(preview["source_bell_ids"])
            remaining_bells = [bell for bell in self._data["bells"] if bell["id"] not in source_ids]
            self._data["bells"] = remaining_bells
            self._data["message_sets"].extend(created_sets)
            self._data["routines"].append(routine)
            await self._persist_and_reschedule()
        return {"routine": deepcopy(routine), "message_sets": deepcopy(created_sets)}

    def _validate_source(
        self, source: dict[str, Any], available_set_ids: set[str] | None = None
    ) -> None:
        if source["kind"] != "message_set":
            return
        valid = available_set_ids or {item["id"] for item in self._data["message_sets"]}
        if source["set_id"] not in valid:
            raise BellValidationError("referenced message set does not exist")

    def _validate_routine_sources(
        self, routine: dict[str, Any], available_set_ids: set[str] | None = None
    ) -> None:
        for step in routine["steps"]:
            self._validate_source(step["message_source"], available_set_ids)

    def _validate_all_references(self) -> None:
        for bell in self._data["bells"]:
            self._validate_source(bell["message_source"])
        for routine in self._data["routines"]:
            self._validate_routine_sources(routine)

    def _message_set_references(self, set_id: str) -> list[str]:
        references = []
        for bell in self._data["bells"]:
            if bell["message_source"].get("set_id") == set_id:
                references.append(f"bell {bell['id']}")
        for routine in self._data["routines"]:
            for step in routine["steps"]:
                if step["message_source"].get("set_id") == set_id:
                    references.append(f"{routine['name']} / {step['name'] or step['time']}")
        return references

    def _find_bell(self, bell_id: str) -> dict[str, Any]:
        try:
            return next(item for item in self._data["bells"] if item["id"] == bell_id)
        except StopIteration as err:
            raise BellValidationError("bell not found") from err

    def _bell_index(self, bell_id: str) -> int:
        for index, item in enumerate(self._data["bells"]):
            if item["id"] == bell_id:
                return index
        raise BellValidationError("bell not found")

    def _find_routine(self, routine_id: str) -> dict[str, Any]:
        try:
            return next(item for item in self._data["routines"] if item["id"] == routine_id)
        except StopIteration as err:
            raise BellValidationError("routine not found") from err

    def _routine_index(self, routine_id: str) -> int:
        for index, item in enumerate(self._data["routines"]):
            if item["id"] == routine_id:
                return index
        raise BellValidationError("routine not found")

    def _find_message_set(self, set_id: str) -> dict[str, Any]:
        try:
            return next(item for item in self._data["message_sets"] if item["id"] == set_id)
        except StopIteration as err:
            raise BellValidationError("message set not found") from err

    def _message_set_index(self, set_id: str) -> int:
        for index, item in enumerate(self._data["message_sets"]):
            if item["id"] == set_id:
                return index
        raise BellValidationError("message set not found")

    def _cancel_all(self) -> None:
        for cancel in self._timers.values():
            cancel()
        self._timers.clear()

    async def _async_reschedule_all(self) -> None:
        self._cancel_all()
        self._generation += 1
        generation = self._generation
        if not self.global_enabled:
            self._notify()
            return
        now = dt_util.utcnow()
        grace = int(self._data["settings"]["one_time_grace_seconds"])
        changed = False
        for key, target, occurrence in self._scheduled_targets():
            if key in self._in_flight:
                continue
            if (
                occurrence is None
                and target["type"] == "one_time"
                and target.get("status") == "pending"
            ):
                scheduled = datetime.fromisoformat(target["datetime"]).astimezone(UTC)
                age = (now - scheduled).total_seconds()
                if target.get("enabled") and 0 <= age <= grace:
                    occurrence = now + timedelta(seconds=1)
                elif age > grace:
                    target["status"] = "missed"
                    changed = True
            if occurrence is None:
                continue

            @callback
            def handle_timer(
                _now: datetime,
                scheduled_key: str = key,
                scheduled_generation: int = generation,
            ) -> None:
                self.hass.async_create_task(
                    self._async_timer_fired(scheduled_key, scheduled_generation)
                )

            self._timers[key] = async_track_point_in_utc_time(
                self.hass,
                handle_timer,
                occurrence,
            )
        if changed:
            await self._store.async_save(self._data)
        self._notify()

    def _target_for_key(self, key: str) -> dict[str, Any]:
        if key.startswith("bell:"):
            return deepcopy(self._find_bell(key.split(":", 1)[1]))
        _prefix, routine_id, step_id = key.split(":", 2)
        routine = self._find_routine(routine_id)
        try:
            step = next(item for item in routine["steps"] if item["id"] == step_id)
        except StopIteration as err:
            raise BellValidationError("routine step not found") from err
        return {
            **deepcopy(step),
            "id": f"{routine_id}:{step_id}",
            "type": "routine",
            "routine_id": routine_id,
            "routine_name": routine["name"],
            "step_id": step_id,
            "step_name": step["name"],
            "routine_enabled": routine["enabled"],
        }

    async def _async_timer_fired(self, key: str, generation: int) -> None:
        if generation != self._generation or key in self._in_flight:
            return
        self._timers.pop(key, None)
        try:
            target = self._target_for_key(key)
        except BellValidationError:
            return
        self._in_flight.add(key)
        succeeded = False
        try:
            allowed = self.global_enabled and target.get("enabled")
            if target["type"] == "routine":
                allowed = allowed and target.get("routine_enabled")
            if allowed:
                succeeded = await self._async_execute(target, test=False)
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Error executing Family Bell %s", key)
        finally:
            if target["type"] == "one_time":
                with suppress(BellValidationError):
                    self._find_bell(target["id"])["status"] = "completed" if succeeded else "missed"
            self._in_flight.discard(key)
            await self._store.async_save(self._data)
            await self._async_reschedule_all()

    def _prune_random_state(self, message_set: dict[str, Any]) -> None:
        state = self._data["random_state"].get(message_set["id"])
        if not state:
            return
        enabled = {item["id"] for item in message_set["messages"] if item["enabled"]}
        state["remaining"] = [item for item in state.get("remaining", []) if item in enabled]
        if state.get("last") not in enabled:
            state["last"] = None

    def _select_message(self, set_id: str, *, consume: bool) -> str:
        message_set = self._find_message_set(set_id)
        enabled = [item for item in message_set["messages"] if item["enabled"]]
        if not enabled:
            raise BellValidationError("message set has no enabled messages")
        by_id = {item["id"]: item for item in enabled}
        stored = self._data["random_state"].setdefault(set_id, {"remaining": [], "last": None})
        state = stored if consume else deepcopy(stored)
        selected_id = advance_shuffle(list(by_id), state, _RANDOM.shuffle)
        return by_id[selected_id]["text"]

    def _render_message(self, target: dict[str, Any], *, test: bool) -> str:
        source = target["message_source"]
        variables = None
        if source["kind"] == "message_set":
            variant = self._select_message(source["set_id"], consume=not test)
            rendered_variant = str(Template(variant, self.hass).async_render(parse_result=False))
            variables = {"random_message": rendered_variant}
        return str(
            Template(source["template"], self.hass).async_render(variables, parse_result=False)
        )

    async def _async_execute(self, target: dict[str, Any], *, test: bool) -> bool:
        available = []
        for entity_id in target["speakers"]:
            state = self.hass.states.get(entity_id)
            if state is None or state.state in {"unavailable", "unknown"}:
                _LOGGER.warning("Skipping unavailable Family Bell target %s", entity_id)
                continue
            available.append(entity_id)
        if not available:
            _LOGGER.error("Family Bell %s has no available speakers", target["id"])
            return False

        # Resolve templates before any audio action so corrupt references fail silently.
        rendered_message = self._render_message(target, test=test)

        async with AsyncExitStack() as stack:
            for entity_id in sorted(available):
                lock = self._speaker_locks.setdefault(entity_id, asyncio.Lock())
                await stack.enter_async_context(lock)
            settings = self._data["settings"]
            if settings["intro_urls"]:
                await self.hass.services.async_call(
                    "media_player",
                    "play_media",
                    {
                        "entity_id": available,
                        "media_content_id": choice(settings["intro_urls"]),
                        "media_content_type": "music",
                    },
                    blocking=True,
                )
                if settings["intro_delay"]:
                    await asyncio.sleep(settings["intro_delay"])

            domain, service = settings["tts_service"].split(".", 1)
            service_data: dict[str, Any] = {
                "entity_id": available,
                "message": rendered_message,
                "cache": should_cache_tts(
                    target["type"],
                    test=test,
                    recurring_cache=settings["cache_recurring_tts"],
                ),
            }
            if settings["language"]:
                service_data["language"] = settings["language"]
            await self.hass.services.async_call(domain, service, service_data, blocking=True)
            hold_seconds = max(
                int(settings["queue_hold_seconds"]), len(rendered_message.split()) / 2.5
            )
            if hold_seconds:
                await asyncio.sleep(hold_seconds)

        entry = {
            "bell_id": target["id"],
            "routine_id": target.get("routine_id"),
            "step_id": target.get("step_id"),
            "fired_at": dt_util.utcnow().isoformat(),
            "message": rendered_message,
            "speakers": available,
            "test": test,
        }
        self._data["history"] = [*self._data["history"][-99:], entry]
        self.hass.bus.async_fire(EVENT_FIRED, entry)
        self._notify()
        return True

    async def _persist_and_reschedule(self) -> None:
        await self._store.async_save(self._data)
        await self._async_reschedule_all()

    async def _persist_and_notify(self) -> None:
        await self._store.async_save(self._data)
        self._notify()

    def _notify(self) -> None:
        self.hass.bus.async_fire(EVENT_UPDATED)
