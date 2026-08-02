"""Pure scheduling and record-validation helpers."""

from __future__ import annotations

from datetime import UTC, datetime, time, timedelta
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

WEEKDAYS = tuple(range(7))
VALID_TYPES = {"weekly", "one_time"}
VALID_STATUSES = {"pending", "completed", "missed"}


class BellValidationError(ValueError):
    """Raised when a bell record is invalid."""


def _parse_time(value: str) -> time:
    try:
        parsed = time.fromisoformat(value)
    except (TypeError, ValueError) as err:
        raise BellValidationError("time must be HH:MM or HH:MM:SS") from err
    return parsed.replace(microsecond=0)


def _parse_datetime(value: str, tz: ZoneInfo) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError) as err:
        raise BellValidationError("datetime must be an ISO date and time") from err
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=tz)
    return parsed


def normalize_bell(
    raw: dict[str, Any], tz: ZoneInfo, *, bell_id: str | None = None
) -> dict[str, Any]:
    """Validate and normalize a bell for JSON storage."""
    bell_type = raw.get("type")
    if bell_type not in VALID_TYPES:
        raise BellValidationError("type must be weekly or one_time")

    message = str(raw.get("message", "")).strip()
    if not message:
        raise BellValidationError("message is required")

    speakers = raw.get("speakers")
    if not isinstance(speakers, list) or not speakers:
        raise BellValidationError("at least one speaker is required")
    normalized_speakers = sorted({str(item).strip() for item in speakers if str(item).strip()})
    if not normalized_speakers or any(
        not item.startswith("media_player.") for item in normalized_speakers
    ):
        raise BellValidationError("speakers must be media_player entity IDs")

    bell: dict[str, Any] = {
        "id": bell_id or str(raw.get("id") or uuid4()),
        "type": bell_type,
        "enabled": bool(raw.get("enabled", True)),
        "message": message,
        "speakers": normalized_speakers,
    }

    if bell_type == "weekly":
        weekday = raw.get("weekday")
        if not isinstance(weekday, int) or weekday not in WEEKDAYS:
            raise BellValidationError("weekday must be 0 (Monday) through 6 (Sunday)")
        bell["weekday"] = weekday
        bell["time"] = _parse_time(str(raw.get("time", ""))).isoformat()
    else:
        scheduled = _parse_datetime(str(raw.get("datetime", "")), tz)
        bell["datetime"] = scheduled.astimezone(tz).isoformat()
        status = str(raw.get("status", "pending"))
        if status not in VALID_STATUSES:
            raise BellValidationError("invalid one-time bell status")
        bell["status"] = status

    return bell


def next_occurrence(bell: dict[str, Any], now_utc: datetime, tz: ZoneInfo) -> datetime | None:
    """Return the next UTC occurrence, or None when it should not be scheduled."""
    if not bell.get("enabled"):
        return None

    now_local = now_utc.astimezone(tz)
    if bell["type"] == "one_time":
        if bell.get("status", "pending") != "pending":
            return None
        scheduled = _parse_datetime(bell["datetime"], tz).astimezone(UTC)
        return scheduled if scheduled > now_utc else None

    bell_time = _parse_time(bell["time"])
    days_ahead = (int(bell["weekday"]) - now_local.weekday()) % 7
    candidate = datetime.combine(now_local.date() + timedelta(days=days_ahead), bell_time, tz)
    if candidate <= now_local:
        candidate += timedelta(days=7)
    return candidate.astimezone(UTC)


def sort_key(bell: dict[str, Any]) -> tuple[Any, ...]:
    """Stable UI sort key."""
    if bell["type"] == "weekly":
        return (0, bell["weekday"], bell["time"], bell["id"])
    return (1, bell["datetime"], bell["id"])
