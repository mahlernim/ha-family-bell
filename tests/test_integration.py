"""Exercise HA setup boundaries and real WebSocket decorators."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import Unauthorized

from custom_components.ha_family_bell import async_setup_entry, websocket
from custom_components.ha_family_bell.const import DATA_MANAGER, DOMAIN
from custom_components.ha_family_bell.schedule import BellValidationError
from custom_components.ha_family_bell.sensor import FamilyBellNextSensor
from custom_components.ha_family_bell.switch import FamilyBellMasterSwitch


@pytest.mark.parametrize("command", websocket.COMMANDS)
def test_every_websocket_command_rejects_non_admin(command):
    connection = SimpleNamespace(user=SimpleNamespace(is_admin=False))
    with pytest.raises(Unauthorized):
        command(Mock(), connection, {"id": 1, "type": command._ws_command})


def test_websocket_update_validates_protocol_and_preserves_record_revision(tmp_path):
    async def run():
        hass = HomeAssistant(str(tmp_path))
        manager = SimpleNamespace(async_update=AsyncMock(return_value={"revision": 4}))
        hass.data[DOMAIN] = {DATA_MANAGER: manager}
        connection = SimpleNamespace(
            user=SimpleNamespace(is_admin=True), send_result=Mock(), send_error=Mock()
        )
        payload = websocket.ws_update._ws_schema(
            {
                "id": 7,
                "type": "ha_family_bell/update",
                "bell_id": "example",
                "changes": {"enabled": False},
                "expected_revision": 3,
            }
        )
        websocket.ws_update(hass, connection, payload)
        await hass.async_block_till_done(wait_background_tasks=True)
        manager.async_update.assert_awaited_once_with("example", {"enabled": False}, 3)
        connection.send_result.assert_called_once_with(7, {"revision": 4})
        connection.send_error.assert_not_called()

    asyncio.run(run())


@pytest.mark.parametrize(
    "error,code",
    [
        (OSError("disk unavailable"), "save_failed"),
        (BellValidationError("Invalid bell"), "invalid_bell"),
    ],
)
def test_websocket_failed_save_has_actionable_response(error, code):
    async def run():
        connection = SimpleNamespace(send_result=Mock(), send_error=Mock())
        await websocket._run(connection, {"id": 2}, AsyncMock(side_effect=error))
        assert connection.send_error.call_args.args[:2] == (2, code)
        connection.send_result.assert_not_called()

    asyncio.run(run())


def test_unloaded_websocket_does_not_crash():
    connection = SimpleNamespace(
        user=SimpleNamespace(is_admin=True), send_result=Mock(), send_error=Mock()
    )
    websocket.ws_list(SimpleNamespace(data={}), connection, {"id": 3})
    assert connection.send_error.call_args.args[:2] == (3, "invalid_bell")


def test_failed_setup_shuts_down_manager_and_removes_panel():
    async def run():
        manager = SimpleNamespace(async_initialize=AsyncMock(), async_shutdown=AsyncMock())
        entry = SimpleNamespace(async_on_unload=Mock())
        hass = SimpleNamespace(
            data={DOMAIN: {}},
            http=SimpleNamespace(async_register_static_paths=AsyncMock()),
            config_entries=SimpleNamespace(
                async_forward_entry_setups=AsyncMock(
                    side_effect=RuntimeError("platform setup failed")
                )
            ),
        )
        with (
            patch("custom_components.ha_family_bell.FamilyBellManager", return_value=manager),
            patch(
                "custom_components.ha_family_bell.panel_custom.async_register_panel",
                new_callable=AsyncMock,
            ),
            patch("custom_components.ha_family_bell.ha_frontend.async_remove_panel") as remove,
        ):
            with pytest.raises(RuntimeError, match="platform setup failed"):
                await async_setup_entry(hass, entry)
            manager.async_initialize.assert_awaited_once_with(start=False)
            manager.async_shutdown.assert_awaited_once()
            assert DATA_MANAGER not in hass.data[DOMAIN]
            remove.assert_called_once()

    asyncio.run(run())


def test_entities_keep_unique_ids_without_polling():
    sensor = FamilyBellNextSensor(Mock())
    switch = FamilyBellMasterSwitch(Mock())
    assert sensor.unique_id == "ha_family_bell_next"
    assert switch.unique_id == "ha_family_bell_schedule"
    assert not sensor.should_poll and not switch.should_poll
