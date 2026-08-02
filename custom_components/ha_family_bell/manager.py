"""Persistent schedule manager and exact-time executor."""

from __future__ import annotations

import asyncio
import logging
from contextlib import AsyncExitStack, suppress
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from random import choice
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_track_point_in_utc_time
from homeassistant.helpers.storage import Store
from homeassistant.helpers.template import Template
from homeassistant.util import dt as dt_util

from .const import DEFAULT_SETTINGS, EVENT_FIRED, EVENT_UPDATED, STORE_KEY, STORE_VERSION
from .schedule import BellValidationError, next_occurrence, normalize_bell, sort_key

_LOGGER = logging.getLogger(__name__)


class FamilyBellManager:
    """Own persisted records, timers, and bell execution."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.timezone = ZoneInfo(hass.config.time_zone)
        self._store: Store[dict[str, Any]] = Store(hass, STORE_VERSION, STORE_KEY)
        self._data: dict[str, Any] = {}
        self._timers: dict[str, Any] = {}
        self._speaker_locks: dict[str, asyncio.Lock] = {}
        self._in_flight: set[str] = set()
        self._generation = 0
        self._mutation_lock = asyncio.Lock()

    @property
    def global_enabled(self) -> bool:
        """Return the master enabled state."""
        return bool(self._data.get("global_enabled", False))

    @property
    def settings(self) -> dict[str, Any]:
        """Return a copy of executor settings."""
        return deepcopy(self._data["settings"])

    async def async_initialize(self) -> None:
        """Load persisted state and schedule records."""
        loaded = await self._store.async_load()
        self._data = loaded or {
            "global_enabled": False,
            "settings": deepcopy(DEFAULT_SETTINGS),
            "bells": [],
            "history": [],
        }
        self._data.setdefault("global_enabled", False)
        self._data["settings"] = {**DEFAULT_SETTINGS, **self._data.get("settings", {})}
        self._data.setdefault("bells", [])
        self._data.setdefault("history", [])
        await self._async_reschedule_all()

    async def async_shutdown(self) -> None:
        """Cancel every pending timer."""
        self._cancel_all()

    def snapshot(self) -> dict[str, Any]:
        """Return frontend-safe data."""
        bells = sorted((deepcopy(item) for item in self._data["bells"]), key=sort_key)
        return {
            "global_enabled": self.global_enabled,
            "settings": self.settings,
            "bells": bells,
            "history": deepcopy(self._data["history"][-50:]),
            "next_bell": self.next_bell(),
            "timezone": self.timezone.key,
        }

    def next_bell(self) -> dict[str, Any] | None:
        """Return the next enabled bell and occurrence."""
        if not self.global_enabled:
            return None
        now = dt_util.utcnow()
        candidates: list[tuple[datetime, dict[str, Any]]] = []
        for bell in self._data["bells"]:
            occurrence = next_occurrence(bell, now, self.timezone)
            if occurrence is not None:
                candidates.append((occurrence, bell))
        if not candidates:
            return None
        occurrence, bell = min(candidates, key=lambda item: item[0])
        return {"bell": deepcopy(bell), "occurrence": occurrence.isoformat()}

    async def async_set_global_enabled(self, enabled: bool) -> None:
        """Set the master switch and rebuild timers."""
        async with self._mutation_lock:
            self._data["global_enabled"] = bool(enabled)
            await self._persist_and_reschedule()

    async def async_update_settings(self, changes: dict[str, Any]) -> None:
        """Validate and update executor settings."""
        allowed = {
            "tts_service",
            "language",
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
        """Create one independent bell."""
        bell = normalize_bell(raw, self.timezone)
        async with self._mutation_lock:
            self._data["bells"].append(bell)
            await self._persist_and_reschedule()
        return deepcopy(bell)

    async def async_update(self, bell_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        """Update one independent bell."""
        async with self._mutation_lock:
            current = self._find(bell_id)
            merged = {**current, **changes, "id": bell_id}
            bell = normalize_bell(merged, self.timezone, bell_id=bell_id)
            self._data["bells"][self._index(bell_id)] = bell
            await self._persist_and_reschedule()
        return deepcopy(bell)

    async def async_delete(self, bell_id: str) -> None:
        """Delete one bell."""
        async with self._mutation_lock:
            self._data["bells"].pop(self._index(bell_id))
            await self._persist_and_reschedule()

    async def async_copy(self, bell_id: str, weekdays: list[int]) -> list[dict[str, Any]]:
        """Create independent weekly copies for selected days."""
        source = self._find(bell_id)
        if source["type"] != "weekly":
            raise BellValidationError("only weekly bells can be copied to weekdays")
        created = []
        async with self._mutation_lock:
            for weekday in sorted(set(weekdays)):
                raw = {**source, "id": None, "weekday": weekday}
                bell = normalize_bell(raw, self.timezone)
                self._data["bells"].append(bell)
                created.append(deepcopy(bell))
            await self._persist_and_reschedule()
        return created

    async def async_import(self, raw_bells: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Append a validated import with every new bell forced off."""
        imported = [
            normalize_bell({**raw, "id": None, "enabled": False}, self.timezone)
            for raw in raw_bells
        ]
        async with self._mutation_lock:
            self._data["bells"].extend(imported)
            await self._persist_and_reschedule()
        return deepcopy(imported)

    async def async_test(self, bell_id: str) -> None:
        """Execute a bell without changing its schedule or status."""
        await self._async_execute(deepcopy(self._find(bell_id)), test=True)
        await self._store.async_save(self._data)

    def _find(self, bell_id: str) -> dict[str, Any]:
        try:
            return next(item for item in self._data["bells"] if item["id"] == bell_id)
        except StopIteration as err:
            raise BellValidationError("bell not found") from err

    def _index(self, bell_id: str) -> int:
        for index, item in enumerate(self._data["bells"]):
            if item["id"] == bell_id:
                return index
        raise BellValidationError("bell not found")

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
        for bell in self._data["bells"]:
            if bell["id"] in self._in_flight:
                continue
            occurrence = next_occurrence(bell, now, self.timezone)
            if (
                occurrence is None
                and bell["type"] == "one_time"
                and bell.get("status") == "pending"
            ):
                scheduled = datetime.fromisoformat(bell["datetime"]).astimezone(UTC)
                age = (now - scheduled).total_seconds()
                if bell.get("enabled") and 0 <= age <= grace:
                    occurrence = now + timedelta(seconds=1)
                elif age > grace:
                    bell["status"] = "missed"
                    changed = True
            if occurrence is None:
                continue
            bell_id = bell["id"]
            self._timers[bell_id] = async_track_point_in_utc_time(
                self.hass,
                lambda _now,
                scheduled_id=bell_id,
                scheduled_generation=generation: self.hass.async_create_task(
                    self._async_timer_fired(scheduled_id, scheduled_generation)
                ),
                occurrence,
            )
        if changed:
            await self._store.async_save(self._data)
        self._notify()

    async def _async_timer_fired(self, bell_id: str, generation: int) -> None:
        if generation != self._generation or bell_id in self._in_flight:
            return
        self._timers.pop(bell_id, None)
        try:
            bell = deepcopy(self._find(bell_id))
        except BellValidationError:
            return
        self._in_flight.add(bell_id)
        succeeded = False
        try:
            if self.global_enabled and bell.get("enabled"):
                succeeded = await self._async_execute(bell, test=False)
        except Exception:  # noqa: BLE001
            _LOGGER.exception("Error executing Family Bell %s", bell_id)
        finally:
            if bell["type"] == "one_time":
                with suppress(BellValidationError):
                    self._find(bell_id)["status"] = "completed" if succeeded else "missed"
            self._in_flight.discard(bell_id)
            await self._store.async_save(self._data)
            await self._async_reschedule_all()

    async def _async_execute(self, bell: dict[str, Any], *, test: bool) -> bool:
        available = []
        for entity_id in bell["speakers"]:
            state = self.hass.states.get(entity_id)
            if state is None or state.state in {"unavailable", "unknown"}:
                _LOGGER.warning("Skipping unavailable Family Bell target %s", entity_id)
                continue
            available.append(entity_id)
        if not available:
            _LOGGER.error("Family Bell %s has no available speakers", bell["id"])
            return False

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
            rendered_message = str(
                Template(bell["message"], self.hass).async_render(parse_result=False)
            )
            service_data: dict[str, Any] = {
                "entity_id": available,
                "message": rendered_message,
            }
            if settings["language"]:
                service_data["language"] = settings["language"]
            await self.hass.services.async_call(domain, service, service_data, blocking=True)
            queue_hold = int(settings["queue_hold_seconds"])
            estimated_speech = len(rendered_message.split()) / 2.5
            if hold_seconds := max(queue_hold, estimated_speech):
                await asyncio.sleep(hold_seconds)

        entry = {
            "bell_id": bell["id"],
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
