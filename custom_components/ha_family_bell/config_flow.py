"""Config flow for HA Family Bell."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.components.tts.const import DATA_COMPONENT, DATA_TTS_MANAGER
from homeassistant.components.tts.helper import get_engine_instance
from homeassistant.helpers import selector
from homeassistant.helpers.storage import Store

from .const import DOMAIN, NAME, STORE_KEY, STORE_VERSION


def _read_saved_data_state(path: Path) -> str:
    """Probe the storage envelope without invoking Store migration or recovery writes."""
    try:
        with path.open(encoding="utf-8") as stored_file:
            envelope = json.load(stored_file)
    except FileNotFoundError:
        return "missing"
    except (OSError, ValueError):
        return "invalid"
    if not isinstance(envelope, dict):
        return "invalid"
    data = envelope.get("data")
    if (
        envelope.get("key") != STORE_KEY
        or envelope.get("version") not in (1, STORE_VERSION)
        or not isinstance(data, dict)
        or not isinstance(data.get("settings"), dict)
        or not isinstance(data.get("bells"), list)
    ):
        return "invalid"
    return "saved"


class FamilyBellConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Create the single HA Family Bell instance."""

    VERSION = 1

    def __init__(self) -> None:
        self._provider: str | None = None

    async def _saved_data_state(self) -> str:
        path = Path(Store(self.hass, STORE_VERSION, STORE_KEY).path)
        return await self.hass.async_add_executor_job(_read_saved_data_state, path)

    def _engine(self, entity_id: str):
        """Resolve a loaded provider without mistaking its initial unknown state for failure."""
        if DATA_COMPONENT not in self.hass.data or DATA_TTS_MANAGER not in self.hass.data:
            return None
        if self.hass.states.get(entity_id) is None:
            return None
        engine = get_engine_instance(self.hass, entity_id)
        if engine is None or not engine.available:
            return None
        return engine

    def _providers(self) -> list[dict[str, str]]:
        return sorted(
            (
                {"value": state.entity_id, "label": state.name}
                for state in self.hass.states.async_all("tts")
                if self._engine(state.entity_id) is not None
            ),
            key=lambda option: (option["label"].casefold(), option["value"]),
        )

    async def _provider_form(self, error: str | None = None):
        providers = self._providers()
        errors = {"base": error} if error else {}
        if not providers:
            errors["base"] = "no_tts_providers"
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required("tts_entity_id"): selector.SelectSelector(
                        selector.SelectSelectorConfig(
                            options=providers, mode=selector.SelectSelectorMode.DROPDOWN
                        )
                    )
                }
                if providers
                else {}
            ),
            errors=errors,
        )

    async def async_step_user(self, user_input: dict[str, Any] | None = None):
        """Handle setup from the integrations page."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        saved_state = await self._saved_data_state()
        if saved_state == "invalid":
            return self.async_abort(reason="invalid_saved_data")
        if saved_state == "saved":
            return await self.async_step_existing()
        if user_input is not None:
            provider = user_input.get("tts_entity_id")
            if not isinstance(provider, str) or provider not in {
                item["value"] for item in self._providers()
            }:
                return await self._provider_form("provider_unavailable")
            self._provider = provider
            return await self.async_step_language()
        return await self._provider_form()

    async def async_step_existing(self, user_input: dict[str, Any] | None = None):
        """Confirm re-adding the integration without overwriting its independent store."""
        if user_input is not None:
            saved_state = await self._saved_data_state()
            if saved_state == "invalid":
                return self.async_abort(reason="invalid_saved_data")
            if saved_state == "missing":
                return await self._provider_form("saved_data_missing")
            self._abort_if_unique_id_configured()
            return self.async_create_entry(title=NAME, data={"use_saved_data": True})
        return self.async_show_form(step_id="existing", data_schema=vol.Schema({}))

    async def async_step_language(self, user_input: dict[str, Any] | None = None):
        """Validate the provider's current language list again before creating the entry."""
        engine = self._engine(self._provider) if self._provider else None
        if engine is None:
            self._provider = None
            return await self._provider_form("provider_unavailable")
        languages = sorted(set(engine.supported_languages or []))
        if not languages:
            self._provider = None
            return await self._provider_form("no_supported_languages")
        errors = {}
        if user_input is not None:
            language = user_input.get("language")
            if language in languages:
                saved_state = await self._saved_data_state()
                if saved_state == "invalid":
                    return self.async_abort(reason="invalid_saved_data")
                if saved_state == "saved":
                    return await self.async_step_existing()
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title=NAME,
                    data={
                        "initial_settings": {
                            "tts_service": "tts.speak",
                            "tts_entity_id": self._provider,
                            "language": language,
                        }
                    },
                )
            errors["language"] = "unsupported_language"
        return self.async_show_form(
            step_id="language",
            data_schema=vol.Schema(
                {
                    vol.Required("language"): selector.SelectSelector(
                        selector.SelectSelectorConfig(
                            options=languages, mode=selector.SelectSelectorMode.DROPDOWN
                        )
                    )
                }
            ),
            errors=errors,
        )
