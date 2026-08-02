"""Admin-only WebSocket CRUD API for the Family Bell panel."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DATA_MANAGER, DOMAIN, EVENT_UPDATED
from .manager import FamilyBellManager
from .schedule import BellValidationError


def _manager(hass: HomeAssistant) -> FamilyBellManager:
    return hass.data[DOMAIN][DATA_MANAGER]


def _error(connection, msg: dict[str, Any], err: Exception) -> None:
    connection.send_error(msg["id"], "invalid_bell", str(err))


@websocket_api.websocket_command({vol.Required("type"): "ha_family_bell/list"})
@websocket_api.require_admin
@callback
def ws_list(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    """Return all schedule data."""
    connection.send_result(msg["id"], _manager(hass).snapshot())


@websocket_api.websocket_command({vol.Required("type"): "ha_family_bell/subscribe"})
@websocket_api.require_admin
@callback
def ws_subscribe(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    """Push a small invalidation event whenever schedule data changes."""
    connection.subscriptions[msg["id"]] = hass.bus.async_listen(
        EVENT_UPDATED,
        lambda _event: connection.send_event(msg["id"], {"updated": True}),
    )
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {vol.Required("type"): "ha_family_bell/create", vol.Required("bell"): dict}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_create(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    try:
        result = await _manager(hass).async_create(msg["bell"])
    except BellValidationError as err:
        _error(connection, msg, err)
        return
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "ha_family_bell/update",
        vol.Required("id"): str,
        vol.Required("changes"): dict,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_update(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    try:
        result = await _manager(hass).async_update(msg["id"], msg["changes"])
    except BellValidationError as err:
        _error(connection, msg, err)
        return
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command(
    {vol.Required("type"): "ha_family_bell/delete", vol.Required("id"): str}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_delete(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    try:
        await _manager(hass).async_delete(msg["id"])
    except BellValidationError as err:
        _error(connection, msg, err)
        return
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {
        vol.Required("type"): "ha_family_bell/copy",
        vol.Required("id"): str,
        vol.Required("weekdays"): [vol.All(int, vol.Range(min=0, max=6))],
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_copy(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    try:
        result = await _manager(hass).async_copy(msg["id"], msg["weekdays"])
    except BellValidationError as err:
        _error(connection, msg, err)
        return
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command(
    {vol.Required("type"): "ha_family_bell/import", vol.Required("bells"): [dict]}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_import(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    """Append imported bells, always disabled for a safe review."""
    try:
        result = await _manager(hass).async_import(msg["bells"])
    except BellValidationError as err:
        _error(connection, msg, err)
        return
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command(
    {vol.Required("type"): "ha_family_bell/test", vol.Required("id"): str}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_test(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    try:
        await _manager(hass).async_test(msg["id"])
    except BellValidationError as err:
        _error(connection, msg, err)
        return
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {vol.Required("type"): "ha_family_bell/set_enabled", vol.Required("enabled"): bool}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_set_enabled(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    await _manager(hass).async_set_global_enabled(msg["enabled"])
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {vol.Required("type"): "ha_family_bell/settings", vol.Required("changes"): dict}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_settings(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    try:
        await _manager(hass).async_update_settings(msg["changes"])
    except BellValidationError as err:
        _error(connection, msg, err)
        return
    connection.send_result(msg["id"])


COMMANDS = (
    ws_list,
    ws_subscribe,
    ws_create,
    ws_update,
    ws_delete,
    ws_copy,
    ws_import,
    ws_test,
    ws_set_enabled,
    ws_settings,
)


def async_register(hass: HomeAssistant) -> None:
    """Register every command once."""
    for command in COMMANDS:
        websocket_api.async_register_command(hass, command)
