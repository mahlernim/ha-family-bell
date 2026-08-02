"""HA Family Bell integration setup."""

from __future__ import annotations

from pathlib import Path

import voluptuous as vol
from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_ID
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv

from .const import (
    DATA_MANAGER,
    DOMAIN,
    PANEL_URL_PATH,
    PANEL_WEB_COMPONENT,
    PLATFORMS,
    STATIC_URL,
)
from .manager import FamilyBellManager
from .websocket import async_register as async_register_websocket

SERVICE_TEST = "test"


async def async_setup(hass: HomeAssistant, _config: dict) -> bool:
    """Register the integration API."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if not domain_data.get("websocket_registered"):
        async_register_websocket(hass)
        domain_data["websocket_registered"] = True

    async def handle_test(call: ServiceCall) -> None:
        await domain_data[DATA_MANAGER].async_test(call.data[CONF_ID])

    if not hass.services.has_service(DOMAIN, SERVICE_TEST):
        hass.services.async_register(
            DOMAIN,
            SERVICE_TEST,
            handle_test,
            schema=vol.Schema({vol.Required(CONF_ID): cv.string}),
        )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up the single config entry."""
    domain_data = hass.data[DOMAIN]
    manager = FamilyBellManager(hass)
    await manager.async_initialize()
    domain_data[DATA_MANAGER] = manager

    if not domain_data.get("static_registered"):
        frontend_dir = Path(__file__).parent / "frontend"
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(frontend_dir), True)]
        )
        domain_data["static_registered"] = True

    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_WEB_COMPONENT,
        sidebar_title="HA Family Bell",
        sidebar_icon="mdi:bell-ring",
        module_url=f"{STATIC_URL}/ha-family-bell-panel.js?v=0.2.0",
        require_admin=True,
        config_panel_domain=DOMAIN,
    )
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload entities, timers, and panel."""
    if not await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        return False
    manager: FamilyBellManager = hass.data[DOMAIN].pop(DATA_MANAGER)
    await manager.async_shutdown()
    frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
    return True
