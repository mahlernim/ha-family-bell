"""Admin-only WebSocket CRUD API for the Family Bell panel."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DATA_MANAGER, DOMAIN, EVENT_UPDATED
from .manager import FamilyBellManager
from .schedule import BellValidationError


def _manager(hass: HomeAssistant) -> FamilyBellManager:
    manager = hass.data.get(DOMAIN, {}).get(DATA_MANAGER)
    if manager is None:
        raise BellValidationError("Family Bell is not loaded. Reload the integration.")
    return manager


def _error(connection, msg: dict[str, Any], err: Exception) -> None:
    connection.send_error(msg["id"], "invalid_bell", str(err))


async def _run(
    connection,
    msg: dict[str, Any],
    operation: Callable[[], Awaitable[Any]],
) -> None:
    try:
        result = await operation()
    except BellValidationError as err:
        _error(connection, msg, err)
        return
    except OSError:
        connection.send_error(
            msg["id"], "save_failed", "Unable to save. Your changes were not applied."
        )
        return
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command({vol.Required("type"): "ha_family_bell/list"})
@websocket_api.require_admin
@callback
def ws_list(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    try:
        connection.send_result(msg["id"], _manager(hass).snapshot())
    except BellValidationError as err:
        _error(connection, msg, err)


@websocket_api.websocket_command({vol.Required("type"): "ha_family_bell/subscribe"})
@websocket_api.require_admin
@callback
def ws_subscribe(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
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
async def ws_create(hass, connection, msg) -> None:
    await _run(connection, msg, lambda: _manager(hass).async_create(msg["bell"]))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "ha_family_bell/update",
        vol.Required("bell_id"): str,
        vol.Required("changes"): dict,
        vol.Optional("expected_revision"): int,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_update(hass, connection, msg) -> None:
    await _run(
        connection,
        msg,
        lambda: _manager(hass).async_update(
            msg["bell_id"], msg["changes"], msg.get("expected_revision")
        ),
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "ha_family_bell/delete", vol.Required("bell_id"): str}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_delete(hass, connection, msg) -> None:
    await _run(connection, msg, lambda: _manager(hass).async_delete(msg["bell_id"]))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "ha_family_bell/copy",
        vol.Required("bell_id"): str,
        vol.Required("weekdays"): [vol.All(int, vol.Range(min=0, max=6))],
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_copy(hass, connection, msg) -> None:
    await _run(
        connection,
        msg,
        lambda: _manager(hass).async_copy(msg["bell_id"], msg["weekdays"]),
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "ha_family_bell/import", vol.Required("bells"): [dict]}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_import(hass, connection, msg) -> None:
    await _run(connection, msg, lambda: _manager(hass).async_import(msg["bells"]))


@websocket_api.websocket_command(
    {vol.Required("type"): "ha_family_bell/test", vol.Required("bell_id"): str}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_test(hass, connection, msg) -> None:
    await _run(connection, msg, lambda: _manager(hass).async_test(msg["bell_id"]))


@websocket_api.websocket_command(
    {vol.Required("type"): "ha_family_bell/set_enabled", vol.Required("enabled"): bool}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_set_enabled(hass, connection, msg) -> None:
    await _run(connection, msg, lambda: _manager(hass).async_set_global_enabled(msg["enabled"]))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "ha_family_bell/settings",
        vol.Required("changes"): dict,
        vol.Optional("expected_revision"): int,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_settings(hass, connection, msg) -> None:
    await _run(
        connection,
        msg,
        lambda: _manager(hass).async_update_settings(msg["changes"], msg.get("expected_revision")),
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "ha_family_bell/routine/create", vol.Required("routine"): dict}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_routine_create(hass, connection, msg) -> None:
    await _run(connection, msg, lambda: _manager(hass).async_create_routine(msg["routine"]))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "ha_family_bell/routine/update",
        vol.Required("routine_id"): str,
        vol.Required("changes"): dict,
        vol.Optional("expected_revision"): int,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_routine_update(hass, connection, msg) -> None:
    await _run(
        connection,
        msg,
        lambda: _manager(hass).async_update_routine(
            msg["routine_id"], msg["changes"], msg.get("expected_revision")
        ),
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "ha_family_bell/routine/delete",
        vol.Required("routine_id"): str,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_routine_delete(hass, connection, msg) -> None:
    await _run(connection, msg, lambda: _manager(hass).async_delete_routine(msg["routine_id"]))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "ha_family_bell/routine/test_step",
        vol.Required("routine_id"): str,
        vol.Required("step_id"): str,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_routine_test_step(hass, connection, msg) -> None:
    await _run(
        connection,
        msg,
        lambda: _manager(hass).async_test_routine_step(msg["routine_id"], msg["step_id"]),
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "ha_family_bell/message_set/create", vol.Required("message_set"): dict}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_message_set_create(hass, connection, msg) -> None:
    await _run(connection, msg, lambda: _manager(hass).async_create_message_set(msg["message_set"]))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "ha_family_bell/message_set/update",
        vol.Required("set_id"): str,
        vol.Required("changes"): dict,
        vol.Optional("expected_revision"): int,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_message_set_update(hass, connection, msg) -> None:
    await _run(
        connection,
        msg,
        lambda: _manager(hass).async_update_message_set(
            msg["set_id"], msg["changes"], msg.get("expected_revision")
        ),
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "ha_family_bell/message_set/delete",
        vol.Required("set_id"): str,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_message_set_delete(hass, connection, msg) -> None:
    await _run(connection, msg, lambda: _manager(hass).async_delete_message_set(msg["set_id"]))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "ha_family_bell/conversion/preview",
        vol.Required("bell_ids"): [str],
        vol.Optional("name", default="Morning Routine"): str,
    }
)
@websocket_api.require_admin
@callback
def ws_conversion_preview(hass, connection, msg) -> None:
    try:
        result = _manager(hass).conversion_preview(msg["bell_ids"], msg["name"])
    except BellValidationError as err:
        _error(connection, msg, err)
        return
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "ha_family_bell/conversion/commit",
        vol.Optional("expected_revision"): int,
        vol.Required("bell_ids"): [str],
        vol.Optional("name", default="Morning Routine"): str,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_conversion_commit(hass, connection, msg) -> None:
    await _run(
        connection,
        msg,
        lambda: _manager(hass).async_commit_conversion(
            msg["bell_ids"], msg["name"], msg.get("expected_revision")
        ),
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "ha_family_bell/routine/patch_steps",
        vol.Required("routine_id"): str,
        vol.Optional("step_id"): str,
        vol.Required("enabled"): bool,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_patch_steps(hass, connection, msg):
    await _run(
        connection,
        msg,
        lambda: _manager(hass).async_patch_steps(
            msg["routine_id"], step_id=msg.get("step_id"), enabled=msg["enabled"]
        ),
    )


@websocket_api.websocket_command({vol.Required("type"): "ha_family_bell/export"})
@websocket_api.require_admin
@callback
def ws_export(hass, connection, msg):
    try:
        connection.send_result(msg["id"], _manager(hass).export_data())
    except BellValidationError as err:
        _error(connection, msg, err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "ha_family_bell/restore/preview",
        vol.Required("payload"): dict,
        vol.Required("mode"): vol.In(["merge", "replace"]),
        vol.Optional("include_settings", default=False): bool,
    }
)
@websocket_api.require_admin
@callback
def ws_restore_preview(hass, connection, msg):
    try:
        connection.send_result(
            msg["id"],
            _manager(hass).restore_preview(msg["payload"], msg["mode"], msg["include_settings"]),
        )
    except BellValidationError as err:
        _error(connection, msg, err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "ha_family_bell/restore/commit",
        vol.Required("payload"): dict,
        vol.Required("mode"): vol.In(["merge", "replace"]),
        vol.Optional("include_settings", default=False): bool,
        vol.Required("fingerprint"): str,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_restore(hass, connection, msg):
    await _run(
        connection,
        msg,
        lambda: _manager(hass).async_restore(
            msg["payload"], msg["mode"], msg["include_settings"], msg["fingerprint"]
        ),
    )


COMMANDS = (
    ws_patch_steps,
    ws_export,
    ws_restore_preview,
    ws_restore,
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
    ws_routine_create,
    ws_routine_update,
    ws_routine_delete,
    ws_routine_test_step,
    ws_message_set_create,
    ws_message_set_update,
    ws_message_set_delete,
    ws_conversion_preview,
    ws_conversion_commit,
)


def async_register(hass: HomeAssistant) -> None:
    for command in COMMANDS:
        websocket_api.async_register_command(hass, command)
