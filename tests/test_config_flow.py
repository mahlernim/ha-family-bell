"""Focused setup-flow coverage with a loaded TTS component fixture."""

import asyncio
import json
from functools import partial
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from homeassistant.components.tts.const import DATA_COMPONENT, DATA_TTS_MANAGER
from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from custom_components.ha_family_bell.config_flow import FamilyBellConfigFlow
from custom_components.ha_family_bell.const import STORE_KEY, STORE_VERSION


class LoadedTtsComponent:
    def __init__(self, entities):
        self.entities = entities

    def get_entity(self, entity_id):
        return self.entities.get(entity_id)


class Engine:
    def __init__(self, languages, *, available=True):
        self.supported_languages = languages
        self.available = available


def run_case(tmp_path, scenario, *, entities=None, providers=None, entries=None):
    async def run():
        hass = HomeAssistant(str(tmp_path))
        hass.config_entries = SimpleNamespace(
            async_entries=lambda *_args: entries or [],
            flow=SimpleNamespace(async_progress_by_handler=lambda *_args, **_kwargs: []),
        )
        hass.data[DATA_COMPONENT] = LoadedTtsComponent(entities or {})
        hass.data[DATA_TTS_MANAGER] = SimpleNamespace(providers=providers or {})
        hass.states.async_set("tts.example", "unknown", {"friendly_name": "Example voice"})
        flow = FamilyBellConfigFlow()
        flow.hass = hass
        flow.async_set_unique_id = AsyncMock()
        flow._abort_if_unique_id_configured = Mock()
        await scenario(hass, flow)

    asyncio.run(run())


async def write_saved_envelope(hass, *, version=STORE_VERSION, data=None):
    path = Path(Store(hass, STORE_VERSION, STORE_KEY).path)
    envelope = {
        "key": STORE_KEY,
        "version": version,
        "data": data or {"settings": {}, "bells": []},
    }
    await hass.async_add_executor_job(partial(path.parent.mkdir, parents=True, exist_ok=True))
    await hass.async_add_executor_job(
        partial(path.write_text, json.dumps(envelope), encoding="utf-8")
    )
    return path


def test_user_flow_requires_explicit_loaded_provider_and_never_calls_audio(tmp_path):
    async def scenario(hass, flow):
        result = await flow.async_step_user()
        assert result["type"] == "form"
        assert result["errors"] == {}
        assert flow._providers() == [{"value": "tts.example", "label": "Example voice"}]
        assert not hass.services.async_services()

        language = await flow.async_step_user({"tts_entity_id": "tts.example"})
        assert language["step_id"] == "language"
        assert not hass.services.async_services()

    run_case(tmp_path, scenario, entities={"tts.example": Engine(["en-US", "ko-KR"])})


def test_provider_rejects_none_unavailable_and_stale_selection(tmp_path):
    async def no_provider(_hass, flow):
        no_provider = await flow.async_step_user()
        assert no_provider["errors"] == {"base": "no_tts_providers"}

    run_case(tmp_path, no_provider, entities={"tts.example": Engine(["en-US"], available=False)})

    async def stale_provider(_hass, flow):
        stale = await flow.async_step_user({"tts_entity_id": "tts.stale"})
        assert stale["errors"] == {"base": "provider_unavailable"}

    run_case(tmp_path, stale_provider, entities={"tts.example": Engine(["en-US"])})

    async def missing_state(hass, flow):
        hass.states.async_remove("tts.example")
        assert flow._engine("tts.example") is None
        assert (await flow.async_step_user())["errors"] == {"base": "no_tts_providers"}

    run_case(tmp_path, missing_state, entities={"tts.example": Engine(["en-US"])})


def test_language_rechecks_current_list_and_creates_exact_selection(tmp_path):
    async def scenario(_hass, flow):
        assert (await flow.async_step_user({"tts_entity_id": "tts.example"}))[
            "step_id"
        ] == "language"
        engine.supported_languages = ["ko-KR"]
        stale = await flow.async_step_language({"language": "en-US"})
        assert stale["errors"] == {"language": "unsupported_language"}
        created = await flow.async_step_language({"language": "ko-KR"})
        assert created["type"] == "create_entry"
        assert created["data"]["initial_settings"] == {
            "tts_service": "tts.speak",
            "tts_entity_id": "tts.example",
            "language": "ko-KR",
        }

    engine = Engine(["en-US", "ko-KR"])
    run_case(tmp_path, scenario, entities={"tts.example": engine})


def test_provider_disappearing_after_selection_returns_to_provider_step(tmp_path):
    async def scenario(hass, flow):
        selected = await flow.async_step_user({"tts_entity_id": "tts.example"})
        assert selected["step_id"] == "language"
        hass.states.async_remove("tts.example")
        hass.states.async_set("tts.alternative", "unknown")
        result = await flow.async_step_language({"language": "en-US"})
        assert result["step_id"] == "user"
        assert result["errors"] == {"base": "provider_unavailable"}

    run_case(
        tmp_path,
        scenario,
        entities={"tts.example": Engine(["en-US"]), "tts.alternative": Engine(["en-US"])},
    )


def test_singleton_and_existing_store_confirmation_do_not_select_defaults(tmp_path):
    async def singleton(_hass, flow):
        result = await flow.async_step_user()
        assert result["type"] == "abort"
        assert result["reason"] == "single_instance_allowed"

    run_case(tmp_path, singleton, entries=[object()])

    async def existing(hass, flow):
        await write_saved_envelope(hass)
        result = await flow.async_step_user()
        assert result["type"] == "form" and result["step_id"] == "existing"
        created = await flow.async_step_existing({})
        assert created["type"] == "create_entry" and created["data"] == {"use_saved_data": True}

    run_case(tmp_path, existing)


def test_saved_data_confirmation_rechecks_file_and_validates_envelope(tmp_path):
    async def missing_before_confirmation(hass, flow):
        path = await write_saved_envelope(hass)
        assert (await flow.async_step_user())["step_id"] == "existing"
        await hass.async_add_executor_job(path.unlink)
        result = await flow.async_step_existing({})
        assert result["step_id"] == "user"
        assert result["errors"] == {"base": "saved_data_missing"}

    run_case(tmp_path, missing_before_confirmation, entities={"tts.example": Engine(["en-US"])})

    async def corrupt(hass, flow):
        await write_saved_envelope(hass, data={"settings": []})
        result = await flow.async_step_user()
        assert result["type"] == "abort" and result["reason"] == "invalid_saved_data"

    run_case(tmp_path, corrupt)


def test_valid_v1_and_v2_saved_envelopes_preserve_readd_path(tmp_path):
    async def scenario(hass, flow):
        await write_saved_envelope(hass, version=version)
        assert (await flow.async_step_user())["step_id"] == "existing"
        created = await flow.async_step_existing({})
        assert created["data"] == {"use_saved_data": True}

    for version in (1, STORE_VERSION):
        run_case(tmp_path / str(version), scenario)
