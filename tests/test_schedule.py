"""Tests for pure schedule behavior."""

import importlib.util
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

MODULE_PATH = Path(__file__).parents[1] / "custom_components" / "ha_family_bell" / "schedule.py"
SPEC = importlib.util.spec_from_file_location("family_bell_schedule", MODULE_PATH)
assert SPEC and SPEC.loader
schedule = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(schedule)

BellValidationError = schedule.BellValidationError
advance_shuffle = schedule.advance_shuffle
build_conversion_preview = schedule.build_conversion_preview
extract_random_template = schedule.extract_random_template
expand_placeholders = schedule.expand_placeholders
next_occurrence = schedule.next_occurrence
normalize_bell = schedule.normalize_bell
normalize_message_set = schedule.normalize_message_set
normalize_routine = schedule.normalize_routine

TZ = ZoneInfo("Asia/Seoul")


def test_weekly_next_occurrence_later_same_day() -> None:
    bell = normalize_bell(
        {
            "type": "weekly",
            "weekday": 0,
            "time": "08:05",
            "message": "Good morning",
            "speakers": ["media_player.bedroom"],
        },
        TZ,
    )
    now = datetime(2026, 8, 2, 22, 0, tzinfo=UTC)  # Monday 07:00 KST
    assert next_occurrence(bell, now, TZ) == datetime(2026, 8, 2, 23, 5, tzinfo=UTC)


def test_weekly_rolls_to_next_week_after_time() -> None:
    bell = normalize_bell(
        {
            "type": "weekly",
            "weekday": 0,
            "time": "08:05",
            "message": "Good morning",
            "speakers": ["media_player.bedroom"],
        },
        TZ,
    )
    now = datetime(2026, 8, 2, 23, 6, tzinfo=UTC)
    assert next_occurrence(bell, now, TZ) == datetime(2026, 8, 9, 23, 5, tzinfo=UTC)


def test_one_time_keeps_explicit_local_time() -> None:
    bell = normalize_bell(
        {
            "type": "one_time",
            "datetime": "2026-08-04T17:30:00",
            "message": "Appointment",
            "speakers": ["media_player.kitchen"],
        },
        TZ,
    )
    assert bell["datetime"] == "2026-08-04T17:30:00+09:00"
    assert next_occurrence(bell, datetime(2026, 8, 4, 8, 0, tzinfo=UTC), TZ) == datetime(
        2026, 8, 4, 8, 30, tzinfo=UTC
    )


def test_rejects_missing_speaker() -> None:
    with pytest.raises(BellValidationError, match="speaker"):
        normalize_bell(
            {"type": "weekly", "weekday": 1, "time": "09:00", "message": "Hello", "speakers": []},
            TZ,
        )


def test_v1_message_becomes_direct_template_source() -> None:
    bell = normalize_bell(
        {
            "id": "legacy",
            "type": "weekly",
            "weekday": 1,
            "time": "09:00",
            "message": "It is {{ now().hour }}",
            "speakers": ["media_player.kitchen"],
        },
        TZ,
    )
    assert bell["id"] == "legacy"
    assert bell["message_source"] == {
        "kind": "template",
        "template": "It is {{ now().hour }}",
    }
    assert "message" not in bell


def test_friendly_placeholders_expand_to_home_assistant_templates() -> None:
    assert expand_placeholders("Boys, it's %time%! %randomset%") == (
        "Boys, it's {{ now().strftime('%H:%M') }}! {{ random_message }}"
    )
    source = schedule.normalize_message_source(
        {
            "kind": "message_set",
            "set_id": "morning",
            "template": "It is %time%. %randomset%",
        }
    )
    assert source["template"] == ("It is {{ now().strftime('%H:%M') }}. {{ random_message }}")


def test_routine_normalizes_exact_time_and_days() -> None:
    routine = normalize_routine(
        {
            "name": "Morning Routine",
            "steps": [
                {
                    "name": "Wake up",
                    "time": "07:05",
                    "weekdays": [4, 0, 4, 2],
                    "message_source": {
                        "kind": "message_set",
                        "set_id": "wake-up",
                        "template": "It is morning. {{ random_message }}",
                    },
                    "speakers": ["media_player.bedroom"],
                }
            ],
        }
    )
    assert routine["steps"][0]["time"] == "07:05:00"
    assert routine["steps"][0]["weekdays"] == [0, 2, 4]


def test_message_set_requires_enabled_message() -> None:
    with pytest.raises(BellValidationError, match="enabled"):
        normalize_message_set({"name": "Muted", "messages": [{"text": "Hello", "enabled": False}]})


def test_extracts_only_one_literal_random_expression() -> None:
    extracted = extract_random_template(
        "It is {{ now().strftime('%H:%M') }}. {{ ['Up', 'Time to move'] | random }}"
    )
    assert extracted == (
        "It is {{ now().strftime('%H:%M') }}. {{ random_message }}",
        ["Up", "Time to move"],
    )
    assert extract_random_template("{{ states('sensor.phrases') | random }}") is None


def test_conversion_groups_weekdays_and_builds_linked_set() -> None:
    template = "Good morning. {{ ['Wake up', 'Rise and shine'] | random }}"
    bells = [
        normalize_bell(
            {
                "id": f"bell-{weekday}",
                "type": "weekly",
                "weekday": weekday,
                "time": "08:05",
                "enabled": False,
                "message": template,
                "speakers": ["media_player.bedroom"],
            },
            TZ,
        )
        for weekday in range(7)
    ]
    preview = build_conversion_preview(bells, [bell["id"] for bell in bells], "Morning")
    assert len(preview["routine"]["steps"]) == 1
    assert preview["routine"]["steps"][0]["weekdays"] == list(range(7))
    assert preview["routine"]["steps"][0]["enabled"] is False
    assert preview["routine"]["steps"][0]["message_source"] == {
        "kind": "message_set",
        "set_key": "set-1",
        "template": "Good morning. {{ random_message }}",
    }
    assert [item["text"] for item in preview["message_sets"][0]["messages"]] == [
        "Wake up",
        "Rise and shine",
    ]


def test_shuffle_uses_every_item_and_avoids_cycle_boundary_repeat() -> None:
    state = {"remaining": [], "last": None}

    def unchanged(_items: list[str]) -> None:
        pass

    first_cycle = [advance_shuffle(["a", "b", "c"], state, unchanged) for _ in range(3)]
    first_next_cycle = advance_shuffle(["a", "b", "c"], state, unchanged)
    assert first_cycle == ["a", "b", "c"]
    assert first_next_cycle == "a"

    boundary_state = {"remaining": [], "last": "a"}
    boundary_selection = advance_shuffle(["a", "b", "c"], boundary_state, unchanged)
    assert boundary_selection == "b"
    assert boundary_state == {"remaining": ["a", "c"], "last": "b"}


def test_shuffle_prunes_disabled_items_from_persisted_bag() -> None:
    state = {"remaining": ["disabled", "active"], "last": "old"}
    selected = advance_shuffle(["active"], state, lambda _items: None)
    assert selected == "active"
    assert state == {"remaining": [], "last": "active"}


def test_websocket_record_keys_do_not_reuse_protocol_id() -> None:
    websocket_source = MODULE_PATH.parent.joinpath("websocket.py").read_text(encoding="utf-8")
    assert 'vol.Required("id"): str' not in websocket_source
    assert 'vol.Required("bell_id"): str' in websocket_source
    assert 'vol.Required("routine_id"): str' in websocket_source
    assert 'vol.Required("set_id"): str' in websocket_source


def test_panel_defaults_to_combined_preview_and_keeps_weekly_standalone() -> None:
    panel_source = MODULE_PATH.parent.joinpath("frontend", "ha-family-bell-panel.js").read_text(
        encoding="utf-8"
    )
    assert 'this.activeTab = "preview"' in panel_source
    assert 'if (this.activeTab === "preview") main = this.weekPreviewGrid();' in panel_source
    assert "Standalone recurring bells only. Routine steps are edited in Routines." in panel_source
    assert "routineOccurrenceRow" not in panel_source
    assert 'data-preview-owner="${entry.ownerType}"' in panel_source
    assert "<span>Source</span><span>Message / set</span>" in panel_source
    assert "<span>Source</span><span>Bell</span>" not in panel_source
    assert "source: row.routine_name" in panel_source
    assert 'data-routine-action="enable-all"' in panel_source
    assert 'data-routine-action="disable-all"' in panel_source
    assert "Routine active" in panel_source
    assert "This saves immediately." in panel_source
