"""Initialization behavior for config-flow supplied TTS settings."""

import asyncio
from copy import deepcopy
from unittest.mock import AsyncMock

import pytest
from homeassistant.core import HomeAssistant

from custom_components.ha_family_bell.manager import FamilyBellManager
from custom_components.ha_family_bell.schedule import BellValidationError


class MemoryStore:
    def __init__(self, data=None, *, fail=False):
        self.saved = deepcopy(data)
        self.fail = fail
        self.saves = 0

    async def async_load(self):
        return deepcopy(self.saved)

    async def async_save(self, data):
        self.saves += 1
        if self.fail:
            raise OSError("storage unavailable")
        self.saved = deepcopy(data)


def run_case(tmp_path, scenario):
    async def run():
        hass = HomeAssistant(str(tmp_path))
        hass.config.time_zone = "UTC"
        await scenario(hass)

    asyncio.run(run())


def initial_settings():
    return {"tts_service": "tts.speak", "tts_entity_id": "tts.example", "language": "ko-KR"}


def test_fresh_store_is_seeded_once_and_existing_store_preserves_settings_and_ids(tmp_path):
    async def scenario(hass):
        first = FamilyBellManager(hass)
        store = MemoryStore()
        first._store = store
        await first.async_initialize(start=False, initial_settings=initial_settings())
        assert first.settings["tts_entity_id"] == "tts.example"
        assert store.saved["settings"]["language"] == "ko-KR"

        existing = deepcopy(store.saved)
        existing["settings"].update(
            {
                "tts_service": "tts.google_translate_say",
                "tts_entity_id": "",
                "language": "ko",
                "intro_delay": 9,
            }
        )
        existing["bells"] = [
            {
                "id": "legacy-id",
                "type": "weekly",
                "weekday": 1,
                "time": "08:00",
                "enabled": False,
                "message": "Hello",
                "speakers": ["media_player.study"],
            }
        ]
        replacement = FamilyBellManager(hass)
        replacement._store = MemoryStore(existing)
        await replacement.async_initialize(start=False, initial_settings=initial_settings())
        assert replacement.settings["tts_service"] == "tts.google_translate_say"
        assert replacement.settings["language"] == "ko"
        assert replacement.settings["intro_delay"] == 9
        assert replacement.snapshot()["bells"][0]["id"] == "legacy-id"

    run_case(tmp_path, scenario)


def test_initial_settings_persistence_failure_does_not_publish_manager_state(tmp_path):
    async def scenario(hass):
        manager = FamilyBellManager(hass)
        manager._store = MemoryStore(fail=True)
        with pytest.raises(OSError, match="storage unavailable"):
            await manager.async_initialize(start=False, initial_settings=initial_settings())
        assert manager._data == {}

    run_case(tmp_path, scenario)


def test_readd_requires_saved_data_and_does_not_seed_new_settings(tmp_path):
    async def scenario(hass):
        manager = FamilyBellManager(hass)
        manager._store = MemoryStore()
        with pytest.raises(
            BellValidationError, match="Saved Family Bell data is no longer available"
        ):
            await manager.async_initialize(
                start=False, initial_settings=initial_settings(), require_saved_data=True
            )
        assert manager._data == {}
        assert manager._store.saved is None

    run_case(tmp_path, scenario)


def test_initial_selected_provider_and_language_reach_test_tts_payload(tmp_path):
    async def scenario(hass):
        manager = FamilyBellManager(hass)
        manager._store = MemoryStore()
        manager._wait_playback = AsyncMock()
        calls = []

        async def record(call):
            calls.append(dict(call.data))

        hass.states.async_set("tts.example", "unknown")
        hass.states.async_set("media_player.study", "idle")
        hass.services.async_register("tts", "speak", record)
        await manager.async_initialize(start=False, initial_settings=initial_settings())
        bell = await manager.async_create(
            {
                "type": "weekly",
                "weekday": 1,
                "time": "08:00",
                "message": "Hello",
                "speakers": ["media_player.study"],
                "enabled": True,
            }
        )
        await manager.async_test(bell["id"])
        assert calls == [
            {
                "message": "Hello",
                "cache": False,
                "language": "ko-KR",
                "entity_id": "tts.example",
                "media_player_entity_id": "media_player.study",
            }
        ]

    run_case(tmp_path, scenario)
