"""Exercise real HA manager behavior; storage, timers and audio are isolated."""

import asyncio
from copy import deepcopy
from datetime import timedelta
from unittest.mock import AsyncMock, Mock, patch

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.util import dt as dt_util

from custom_components.ha_family_bell.manager import FamilyBellManager, FamilyBellStore
from custom_components.ha_family_bell.schedule import BellValidationError


class MemoryStore:
    def __init__(self, data=None):
        self.saved = deepcopy(data)
        self.fail = False
        self.entered = asyncio.Event()
        self.release = None

    async def async_load(self):
        return deepcopy(self.saved)

    async def async_save(self, data):
        self.entered.set()
        if self.release:
            await self.release.wait()
        if self.fail:
            raise OSError("disk unavailable")
        self.saved = deepcopy(data)


class Harness:
    def __init__(self, tmp_path, data=None):
        self.hass = HomeAssistant(str(tmp_path))
        self.hass.config.time_zone = "UTC"
        self.manager = FamilyBellManager(self.hass)
        self.manager._store = self.store = MemoryStore(data)
        self.manager._wait_playback = AsyncMock()
        self.calls = []
        self.timers = []
        self.hass.states.async_set("media_player.study", "idle")
        self.hass.states.async_set("media_player.hall", "idle")
        self.hass.states.async_set("tts.example", "unknown")
        self.audio_hook = None

        async def record(call):
            self.calls.append((call.domain, call.service, dict(call.data)))
            if self.audio_hook:
                await self.audio_hook(call)

        self.hass.services.async_register("tts", "google_translate_say", record)
        self.hass.services.async_register("tts", "speak", record)
        self.hass.services.async_register("media_player", "play_media", record)

    def timer(self, _hass, action, when):
        cancel = Mock()
        self.timers.append((action, when, cancel))
        return cancel

    async def bell(self, **changes):
        return await self.manager.async_create(
            {
                "type": "weekly",
                "weekday": 0,
                "time": "08:00",
                "message": "Hello",
                "speakers": ["media_player.study"],
                "enabled": True,
                **changes,
            }
        )

    async def routine(self):
        return await self.manager.async_create_routine(
            {
                "name": "Weekday",
                "enabled": True,
                "steps": [
                    {
                        "id": name,
                        "name": name,
                        "time": "08:00",
                        "weekdays": [0, 1],
                        "message": "Hello",
                        "speakers": ["media_player.study"],
                        "enabled": True,
                    }
                    for name in ("first", "second")
                ],
            }
        )

    async def fire(self, bell):
        key = "bell:" + bell["id"]
        return await self.manager._async_timer_fired(key, self.manager._timers[key]["token"])


def run_case(tmp_path, scenario, data=None):
    async def run():
        harness = Harness(tmp_path, data)
        with patch(
            "custom_components.ha_family_bell.manager.async_track_point_in_utc_time", harness.timer
        ):
            await harness.manager.async_initialize()
            try:
                await scenario(harness)
            finally:
                await harness.manager.async_shutdown()

    asyncio.run(run())


def test_failed_save_leaves_records_timers_and_revision_unchanged(tmp_path):
    async def scenario(h):
        bell = await h.bell()
        await h.manager.async_set_global_enabled(True)
        snapshot = h.manager.snapshot()
        timers = dict(h.manager._timers)
        h.store.fail = True
        with pytest.raises(OSError):
            await h.manager.async_update(bell["id"], {"time": "09:00"})
        assert h.manager.snapshot() == snapshot
        assert h.manager._timers == timers
        h.store.fail = False

    run_case(tmp_path, scenario)


def test_real_ha_store_write_failure_reaches_transaction(tmp_path):
    from homeassistant.util.file import WriteError

    async def scenario(h):
        before = h.manager.snapshot()
        h.manager._store = FamilyBellStore(h.hass, 2, "family_bell_test", atomic_writes=True)
        with (
            patch.object(
                FamilyBellStore, "_write_prepared_data", side_effect=WriteError("disk failure")
            ),
            pytest.raises(OSError, match="persist"),
        ):
            await h.bell()
        assert h.manager.snapshot() == before

    run_case(tmp_path, scenario)


def test_cancelled_crud_waits_for_atomic_write_and_publishes_saved_state(tmp_path):
    async def scenario(h):
        h.store.entered.clear()
        h.store.release = asyncio.Event()
        save = asyncio.create_task(h.bell())
        await h.store.entered.wait()
        save.cancel()
        await asyncio.sleep(0)
        assert not save.done()
        shutdown = asyncio.create_task(h.manager.async_shutdown())
        await asyncio.sleep(0)
        assert not shutdown.done()
        h.store.release.set()
        result = await asyncio.gather(save, shutdown, return_exceptions=True)
        assert isinstance(result[0], asyncio.CancelledError)
        assert h.manager._data == h.store.saved
        assert len(h.store.saved["bells"]) == 1
        assert not h.manager._timers

    run_case(tmp_path, scenario)


def test_shutdown_waits_for_crud_save_and_rejects_future_changes(tmp_path):
    async def scenario(h):
        h.store.entered.clear()
        h.store.release = asyncio.Event()
        save = asyncio.create_task(h.bell())
        await h.store.entered.wait()
        shutdown = asyncio.create_task(h.manager.async_shutdown())
        await asyncio.sleep(0)
        assert not shutdown.done()
        h.store.release.set()
        await asyncio.gather(save, shutdown)
        assert h.manager._timers == {}
        with pytest.raises(BellValidationError, match="unloading"):
            await h.bell()

    run_case(tmp_path, scenario)


@pytest.mark.parametrize("action", ["pause", "delete", "shutdown"])
def test_queued_playback_is_cancelled_without_audio(tmp_path, action):
    async def scenario(h):
        bell = await h.bell()
        await h.manager.async_set_global_enabled(True)
        lock = h.manager._speaker_locks.setdefault("media_player.study", asyncio.Lock())
        await lock.acquire()
        job = asyncio.create_task(h.fire(bell))
        await asyncio.sleep(0)
        assert h.manager.snapshot()["activity"][0]["status"] == "queued"
        if action == "pause":
            await h.manager.async_set_global_enabled(False)
        elif action == "delete":
            await h.manager.async_delete(bell["id"])
        else:
            await h.manager.async_shutdown()
        lock.release()
        result = await asyncio.gather(job, return_exceptions=True)
        assert isinstance(result[0], asyncio.CancelledError)
        assert h.calls == []
        assert h.manager._timers == {}
        assert h.manager._jobs == {}

    run_case(tmp_path, scenario)


def test_pause_during_chime_cancels_tts(tmp_path):
    async def scenario(h):
        bell = await h.bell()
        await h.manager.async_update_settings(
            {"intro_urls": ["/local/chime.mp3"], "intro_delay": 60}
        )
        await h.manager.async_set_global_enabled(True)
        started = asyncio.Event()

        async def hook(_call):
            started.set()

        h.audio_hook = hook
        job = asyncio.create_task(h.fire(bell))
        await started.wait()
        await h.manager.async_set_global_enabled(False)
        await asyncio.gather(job, return_exceptions=True)
        assert [(domain, service) for domain, service, _data in h.calls] == [
            ("media_player", "play_media")
        ]

    run_case(tmp_path, scenario)


def test_reload_cancels_inflight_jobs_and_old_callbacks(tmp_path):
    async def scenario(h):
        bell = await h.bell()
        await h.manager.async_set_global_enabled(True)
        old_callback = h.timers[-1][0]
        entered = asyncio.Event()

        async def wait(*args):
            entered.set()
            await asyncio.Event().wait()

        h.manager._wait_playback = wait
        job = asyncio.create_task(h.fire(bell))
        await entered.wait()
        await h.manager.async_shutdown()
        old_callback(dt_util.utcnow())
        await asyncio.gather(job, return_exceptions=True)
        assert len(h.calls) == 1
        assert h.manager._timers == {}
        assert h.manager._jobs == {}
        assert h.manager.snapshot()["activity"] == []

    run_case(tmp_path, scenario)


def test_simultaneous_timers_survive_unrelated_save(tmp_path):
    async def scenario(h):
        first, second = await h.bell(), await h.bell()
        await h.manager.async_set_global_enabled(True)
        token = h.manager._timers["bell:" + second["id"]]["token"]
        await h.fire(first)
        assert h.manager._timers["bell:" + second["id"]]["token"] == token
        await h.fire(second)
        assert len(h.calls) == 2

    run_case(tmp_path, scenario)


def test_atomic_step_toggles_and_revision_conflicts(tmp_path):
    async def scenario(h):
        routine = await h.routine()
        await asyncio.gather(
            *[
                h.manager.async_patch_steps(routine["id"], step_id=step, enabled=False)
                for step in ("first", "second")
            ]
        )
        current = h.manager.snapshot()["routines"][0]
        assert [s["enabled"] for s in current["steps"]] == [False, False]
        with pytest.raises(BellValidationError, match="changed elsewhere"):
            await h.manager.async_update_routine(
                routine["id"], {"steps": routine["steps"]}, routine["revision"]
            )
        await h.manager.async_patch_steps(routine["id"], step_id="first", enabled=True)
        await h.manager.async_update_routine(routine["id"], {"enabled": False})
        await h.manager.async_update_routine(routine["id"], {"enabled": True})
        assert [s["enabled"] for s in h.manager.snapshot()["routines"][0]["steps"]] == [True, False]

    run_case(tmp_path, scenario)


def test_missing_speakers_report_failed_test_and_history(tmp_path):
    async def scenario(h):
        bell = await h.bell(speakers=["media_player.missing"])
        with pytest.raises(BellValidationError, match="No selected speaker"):
            await h.manager.async_test(bell["id"])
        history = h.manager.snapshot()["history"][-1]
        assert history["status"] == "failed"
        assert history["speaker_results"] == {"media_player.missing": "unavailable"}
        assert not h.calls

    run_case(tmp_path, scenario)


@pytest.mark.parametrize("modern", [False, True])
def test_tts_payloads_partial_results_and_routine_sensor_id(tmp_path, modern):
    async def scenario(h):
        if modern:
            await h.manager.async_update_settings(
                {"tts_service": "tts.speak", "tts_entity_id": "tts.example"}
            )
        routine = await h.routine()
        await h.manager.async_update_routine(
            routine["id"],
            {
                "steps": [
                    {
                        **routine["steps"][0],
                        "speakers": ["media_player.study", "media_player.missing"],
                    },
                ]
            },
        )
        result = await h.manager.async_test(routine["id"] + ":first")
        assert result["status"] == "partial"
        assert result["speaker_results"]["media_player.missing"] == "unavailable"
        payload = h.calls[0][2]
        assert payload["entity_id"] == ("tts.example" if modern else "media_player.study")
        assert payload.get("media_player_entity_id") == ("media_player.study" if modern else None)
        assert payload["cache"] is False

    run_case(tmp_path, scenario)


def test_one_speaker_failure_does_not_cancel_other_speakers(tmp_path):
    async def scenario(h):
        bell = await h.bell(speakers=["media_player.study", "media_player.hall"])

        async def hook(call):
            if call.data["entity_id"] == "media_player.hall":
                raise HomeAssistantError("provider unavailable")

        h.audio_hook = hook
        result = await h.manager.async_test(bell["id"])
        assert result["status"] == "partial"
        assert result["speaker_results"] == {
            "media_player.hall": "failed",
            "media_player.study": "sent",
        }

    run_case(tmp_path, scenario)


def test_one_time_remains_completed_until_explicit_future_reschedule(tmp_path):
    async def scenario(h):
        bell = await h.bell(
            type="one_time", datetime=(dt_util.utcnow() + timedelta(days=1)).isoformat()
        )
        await h.manager.async_set_global_enabled(True)
        await h.fire(bell)
        saved = await h.manager.async_update(
            bell["id"],
            {"message": "Updated", "message_source": {"kind": "template", "template": "Updated"}},
        )
        assert saved["status"] == "completed"
        with pytest.raises(BellValidationError, match="new future time"):
            await h.manager.async_update(bell["id"], {"status": "pending"})
        rescheduled = await h.manager.async_update(
            bell["id"],
            {"status": "pending", "datetime": (dt_util.utcnow() + timedelta(days=2)).isoformat()},
        )
        assert rescheduled["status"] == "pending"

    run_case(tmp_path, scenario)


def test_one_time_claim_blocks_replay_after_failed_outcome_save_and_restart(tmp_path):
    async def scenario(h):
        bell = await h.bell(type="one_time", datetime=dt_util.utcnow().isoformat())
        await h.manager.async_set_global_enabled(True)

        async def fail_outcome(_call):
            h.store.fail = True

        h.audio_hook = fail_outcome
        await h.fire(bell)
        assert len(h.calls) == 1
        assert not h.manager._timers
        assert h.store.saved["pending_runs"] == [bell["id"]]
        await h.manager.async_shutdown()
        h.store.fail = False
        replacement = FamilyBellManager(h.hass)
        replacement._store = h.store
        await replacement.async_initialize()
        assert replacement.snapshot()["bells"][0]["status"] == "missed"
        assert not replacement._timers
        await replacement.async_shutdown()

    run_case(tmp_path, scenario)


def test_creates_own_ids_and_rejects_duplicate_nested_ids(tmp_path):
    async def scenario(h):
        first = await h.bell(id="supplied")
        second = await h.bell(id="supplied")
        assert first["id"] != second["id"] != "supplied"
        with pytest.raises(BellValidationError, match="unique"):
            await h.manager.async_create_message_set(
                {
                    "name": "Choices",
                    "messages": [
                        {"id": "same", "text": "one"},
                        {"id": "same", "text": "two"},
                    ],
                }
            )

    run_case(tmp_path, scenario)


def test_template_validation_and_test_does_not_consume_shuffle_bag(tmp_path):
    async def scenario(h):
        with pytest.raises(BellValidationError, match="Invalid message template"):
            await h.bell(message="{{ broken")
        message_set = await h.manager.async_create_message_set(
            {"name": "Choices", "messages": ["one", "two"]}
        )
        bell = await h.bell(
            message_source={
                "kind": "message_set",
                "template": "%randomset%",
                "set_id": message_set["id"],
            }
        )
        await h.manager.async_test(bell["id"])
        assert h.store.saved["random_state"] == {}
        await h.manager.async_set_global_enabled(True)
        await h.fire(bell)
        assert len(h.store.saved["random_state"][message_set["id"]]["remaining"]) == 1
        with pytest.raises(BellValidationError, match="referenced"):
            await h.manager.async_delete_message_set(message_set["id"])

    run_case(tmp_path, scenario)


@pytest.mark.parametrize("mode", ["merge", "replace"])
def test_full_restore_remaps_ids_and_links_and_disables_imports(tmp_path, mode):
    async def scenario(h):
        message_set = await h.manager.async_create_message_set(
            {"name": "Choices", "messages": ["one", "two"]}
        )
        await h.bell(
            message_source={
                "kind": "message_set",
                "template": "%randomset%",
                "set_id": message_set["id"],
            }
        )
        await h.routine()
        await h.manager.async_set_global_enabled(True)
        backup = h.manager.export_data()
        preview = h.manager.restore_preview(backup, mode, True)
        assert preview["counts"] == {"bells": 1, "routines": 1, "message_sets": 1}
        await h.manager.async_restore(backup, mode, True, preview["fingerprint"])
        snapshot = h.manager.snapshot()
        imported = snapshot["routines"][-1]
        assert not imported["enabled"] and not any(s["enabled"] for s in imported["steps"])
        assert snapshot["global_enabled"] is (mode == "merge")
        restored_set = snapshot["message_sets"][-1]
        imported_bell = next(b for b in snapshot["bells"] if b["id"] != backup["bells"][0]["id"])
        assert not imported_bell["enabled"]
        assert imported_bell["message_source"]["set_id"] == restored_set["id"]
        assert restored_set["id"] != message_set["id"]
        assert len(snapshot["bells"]) == (2 if mode == "merge" else 1)

    run_case(tmp_path, scenario)


def test_restore_requires_fresh_preview_and_is_atomic(tmp_path):
    async def scenario(h):
        await h.bell()
        backup = h.manager.export_data()
        preview = h.manager.restore_preview(backup, "replace")
        await h.bell()
        with pytest.raises(BellValidationError, match="Preview"):
            await h.manager.async_restore(backup, "replace", False, preview["fingerprint"])
        with pytest.raises(BellValidationError, match="time zone differs"):
            h.manager.restore_preview({**backup, "timezone": "Asia/Seoul"})
        preview = h.manager.restore_preview(backup, "replace")
        before = h.manager.snapshot()
        h.store.fail = True
        with pytest.raises(OSError):
            await h.manager.async_restore(backup, "replace", False, preview["fingerprint"])
        assert h.manager.snapshot() == before
        h.store.fail = False

    run_case(tmp_path, scenario)


def test_scheduling_waits_for_home_assistant_started(tmp_path):
    async def run():
        h = Harness(tmp_path)
        with patch(
            "custom_components.ha_family_bell.manager.async_track_point_in_utc_time", h.timer
        ):
            await h.manager.async_initialize(start=False)
            await h.bell()
            await h.manager.async_set_global_enabled(True)
            assert h.manager._timers == {}
            await h.manager.async_start()
            assert len(h.manager._timers) == 1
            await h.manager.async_shutdown()

    asyncio.run(run())


def test_existing_v2_store_retains_settings_ids_schedules_and_shuffle(tmp_path):
    old = {
        "global_enabled": True,
        "settings": {
            "tts_service": "tts.google_translate_say",
            "language": "ko",
            "intro_urls": ["/local/chime.mp3"],
            "intro_delay": 4,
            "queue_hold_seconds": 3,
            "one_time_grace_seconds": 120,
            "cache_recurring_tts": True,
        },
        "bells": [
            {
                "id": "old-bell",
                "type": "one_time",
                "datetime": "2026-01-01T08:00:00+00:00",
                "enabled": True,
                "status": "completed",
                "message_source": {"kind": "template", "template": "Hello"},
                "speakers": ["media_player.study"],
            }
        ],
        "routines": [
            {
                "id": "old-routine",
                "name": "Morning",
                "enabled": False,
                "steps": [
                    {
                        "id": "old-step",
                        "name": "",
                        "time": "08:00:00",
                        "weekdays": [0],
                        "enabled": True,
                        "speakers": ["media_player.study"],
                        "message_source": {
                            "kind": "message_set",
                            "set_id": "old-set",
                            "template": "{{ random_message }}",
                        },
                    },
                ],
            }
        ],
        "message_sets": [
            {
                "id": "old-set",
                "name": "Choices",
                "messages": [
                    {"id": "variant", "enabled": True, "text": "Hello"},
                ],
            }
        ],
        "random_state": {"old-set": {"remaining": [], "last": "variant"}},
        "history": [],
    }

    async def scenario(h):
        current = h.manager.snapshot()
        assert current["global_enabled"] is True
        assert current["bells"][0]["id"] == "old-bell"
        assert current["bells"][0]["status"] == "completed"
        assert current["routines"][0]["steps"][0] == old["routines"][0]["steps"][0]
        assert current["message_sets"][0]["messages"] == old["message_sets"][0]["messages"]
        assert h.store.saved["random_state"] == old["random_state"]
        assert all(current["settings"][key] == value for key, value in old["settings"].items())
        assert current["settings"]["playback_timeout_seconds"] == 180

    run_case(tmp_path, scenario, old)


def test_player_feedback_releases_queue_after_playback(tmp_path):
    async def scenario(h):
        before = h.hass.states.get("media_player.study")
        h.hass.states.async_set("media_player.study", "playing")
        real_wait = FamilyBellManager._wait_playback(
            h.manager,
            "media_player.study",
            before,
            "Long " * 100,
            {"queue_hold_seconds": 0, "playback_timeout_seconds": 10},
        )
        job = asyncio.create_task(real_wait)
        await asyncio.sleep(0)
        assert not job.done()
        h.hass.states.async_set("media_player.study", "idle")
        await asyncio.wait_for(job, timeout=2)

    run_case(tmp_path, scenario)
