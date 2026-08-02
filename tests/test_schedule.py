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
next_occurrence = schedule.next_occurrence
normalize_bell = schedule.normalize_bell

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
