"""Deletion protocol keeps stale clients from removing newer records."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from test_manager import run_case

from custom_components.ha_family_bell import websocket
from custom_components.ha_family_bell.const import DATA_MANAGER, DOMAIN


@pytest.mark.parametrize("kind", ["bell", "routine", "message_set"])
def test_delete_rejects_stale_record_and_keeps_legacy_call_compatible(tmp_path, kind):
    async def scenario(h):
        if kind == "bell":
            record = await h.bell()
            await h.manager.async_update(record["id"], {"message": "Newer message"})
            command, field, collection = websocket.ws_delete, "bell_id", "bells"
        elif kind == "routine":
            record = await h.routine()
            await h.manager.async_update_routine(record["id"], {"name": "Newer routine"})
            command, field, collection = (websocket.ws_routine_delete, "routine_id", "routines")
        else:
            record = await h.manager.async_create_message_set(
                {"name": "Messages", "messages": [{"text": "Hello", "enabled": True}]}
            )
            await h.manager.async_update_message_set(record["id"], {"name": "Newer set"})
            command, field, collection = (websocket.ws_message_set_delete, "set_id", "message_sets")
        h.hass.data[DOMAIN] = {DATA_MANAGER: h.manager}
        connection = SimpleNamespace(
            user=SimpleNamespace(is_admin=True), send_result=Mock(), send_error=Mock()
        )
        request = {"id": 1, "type": command._ws_command, field: record["id"]}
        guarded = command._ws_schema({**request, "expected_revision": record["revision"]})
        command(h.hass, connection, guarded)
        await h.hass.async_block_till_done(wait_background_tasks=True)
        assert connection.send_error.call_args.args[1] == "invalid_bell"
        assert "changed elsewhere" in connection.send_error.call_args.args[2]
        assert len(h.manager.snapshot()[collection]) == 1
        connection.send_error.reset_mock()
        command(h.hass, connection, command._ws_schema(request))
        await h.hass.async_block_till_done(wait_background_tasks=True)
        connection.send_error.assert_not_called()
        assert h.manager.snapshot()[collection] == []

    run_case(tmp_path, scenario)
