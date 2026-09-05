"""Pure scheduling, validation, and conversion helpers."""

from __future__ import annotations

import ast
import re
from collections import defaultdict
from collections.abc import Callable
from datetime import UTC, datetime, time, timedelta
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

WEEKDAYS = tuple(range(7))
VALID_TYPES = {"weekly", "one_time"}
VALID_STATUSES = {"pending", "completed", "missed"}
VALID_MESSAGE_KINDS = {"template", "message_set"}
FRIENDLY_PLACEHOLDERS = {
    "%time%": "{{ now().strftime('%H:%M') }}",
    "%randomset%": "{{ random_message }}",
}


def should_cache_tts(target_type: str, *, test: bool, recurring_cache: bool) -> bool:
    """Return whether this announcement should use the Home Assistant TTS cache."""
    return bool(recurring_cache and not test and target_type in {"weekly", "routine"})


_RANDOM_EXPRESSION = re.compile(r"{{\s*(\[(?:[^\[\]]|\n)*\])\s*\|\s*random\s*}}", re.DOTALL)


class BellValidationError(ValueError):
    """Raised when a Family Bell record is invalid."""


def expand_placeholders(template: str) -> str:
    """Translate friendly editor placeholders to Home Assistant templates."""
    for placeholder, expression in FRIENDLY_PLACEHOLDERS.items():
        template = template.replace(placeholder, expression)
    return template


def _new_id(raw: dict[str, Any], forced_id: str | None = None) -> str:
    value = forced_id or raw.get("id") or str(uuid4())
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
        raise BellValidationError("IDs must contain only letters, numbers, underscores or hyphens")
    return value


def _boolean(raw: dict[str, Any], key: str = "enabled", default: bool = True) -> bool:
    value = raw.get(key, default)
    if not isinstance(value, bool):
        raise BellValidationError(f"{key} must be true or false")
    return value


def _text(value: Any, field: str, *, limit: int = 10000) -> str:
    if not isinstance(value, str) or len(value) > limit:
        raise BellValidationError(f"{field} must be text of at most {limit} characters")
    return value.strip()


def _record(raw: Any) -> None:
    if not isinstance(raw, dict):
        raise BellValidationError("expected an object")


def _unique(items: list[dict[str, Any]], label: str) -> None:
    ids = [item["id"] for item in items]
    if len(ids) != len(set(ids)):
        raise BellValidationError(f"{label} IDs must be unique")


def _parse_time(value: str) -> time:
    try:
        parsed = time.fromisoformat(value)
    except (TypeError, ValueError) as err:
        raise BellValidationError("time must be HH:MM or HH:MM:SS") from err
    if parsed.tzinfo is not None:
        raise BellValidationError("recurring times must be local times without a UTC offset")
    # Bell schedules intentionally use minute precision. Continue accepting
    # older/API values with seconds, but normalize them before persistence.
    return parsed.replace(second=0, microsecond=0)


def _parse_datetime(value: str, tz: ZoneInfo) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError) as err:
        raise BellValidationError("datetime must be an ISO date and time") from err
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=tz)
        if parsed.astimezone(UTC).astimezone(tz).replace(tzinfo=None) != parsed.replace(
            tzinfo=None
        ):
            raise BellValidationError("this local time does not exist because the clock changes")
    return parsed.replace(second=0, microsecond=0)


def _normalize_speakers(value: Any) -> list[str]:
    if not isinstance(value, list) or not value:
        raise BellValidationError("at least one speaker is required")
    if len(value) > 100 or any(not isinstance(item, str) for item in value):
        raise BellValidationError("speakers must be a list of at most 100 entity IDs")
    speakers = sorted({item.strip() for item in value if item.strip()})
    if not speakers or any(
        not re.fullmatch(r"media_player\.[a-z0-9_]+", item) for item in speakers
    ):
        raise BellValidationError("speakers must be media_player entity IDs")
    return speakers


def normalize_message_source(raw: Any) -> dict[str, str]:
    """Normalize a direct template or linked message-set source."""
    if isinstance(raw, str):
        raw = {"kind": "template", "template": raw}
    if not isinstance(raw, dict):
        raise BellValidationError("message source is required")
    kind = str(raw.get("kind", "template"))
    if kind not in VALID_MESSAGE_KINDS:
        raise BellValidationError("message kind must be template or message_set")
    template = expand_placeholders(_text(raw.get("template", ""), "message template"))
    if not template:
        raise BellValidationError("message template is required")
    source = {"kind": kind, "template": template}
    if kind == "message_set":
        set_id = _text(raw.get("set_id", ""), "message set ID", limit=128)
        if not set_id:
            raise BellValidationError("message set is required")
        if "random_message" not in template:
            raise BellValidationError("linked template must contain random_message")
        source["set_id"] = set_id
    return source


def normalize_bell(
    raw: dict[str, Any], tz: ZoneInfo, *, bell_id: str | None = None
) -> dict[str, Any]:
    """Validate and normalize an independent bell for JSON storage."""
    _record(raw)
    bell_type = raw.get("type")
    if bell_type not in VALID_TYPES:
        raise BellValidationError("type must be weekly or one_time")
    source = normalize_message_source(raw.get("message_source", raw.get("message", "")))
    bell: dict[str, Any] = {
        "id": _new_id(raw, bell_id),
        "type": bell_type,
        "enabled": _boolean(raw),
        "message_source": source,
        "speakers": _normalize_speakers(raw.get("speakers")),
    }
    if bell_type == "weekly":
        weekday = raw.get("weekday")
        if type(weekday) is not int or weekday not in WEEKDAYS:
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


def normalize_message_set(raw: dict[str, Any], *, set_id: str | None = None) -> dict[str, Any]:
    """Validate a reusable random-message set."""
    _record(raw)
    name = _text(raw.get("name", ""), "message set name", limit=200)
    if not name:
        raise BellValidationError("message set name is required")
    raw_items = raw.get("messages")
    if not isinstance(raw_items, list) or not raw_items or len(raw_items) > 1000:
        raise BellValidationError("message set must contain at least one message")
    items = []
    for item in raw_items:
        if isinstance(item, str):
            item = {"text": item}
        if not isinstance(item, dict):
            raise BellValidationError("message-set entries must be text records")
        text = _text(item.get("text", ""), "message-set text")
        if not text:
            raise BellValidationError("message-set text cannot be empty")
        items.append(
            {
                "id": _new_id(item),
                "text": text,
                "enabled": _boolean(item),
            }
        )
    if not any(item["enabled"] for item in items):
        raise BellValidationError("message set must have at least one enabled message")
    _unique(items, "message")
    return {"id": _new_id(raw, set_id), "name": name, "messages": items}


def normalize_routine_step(raw: dict[str, Any], *, step_id: str | None = None) -> dict[str, Any]:
    """Validate one exact-time routine step."""
    _record(raw)
    weekdays = raw.get("weekdays")
    if not isinstance(weekdays, list):
        raise BellValidationError("routine step weekdays must be a list")
    if any(type(day) is not int for day in weekdays):
        raise BellValidationError("weekdays must be integer numbers")
    normalized_days = sorted(set(weekdays))
    if not normalized_days or any(day not in WEEKDAYS for day in normalized_days):
        raise BellValidationError("routine step needs at least one valid weekday")
    name = _text(raw.get("name", ""), "bell name", limit=200)
    return {
        "id": _new_id(raw, step_id),
        "name": name,
        "enabled": _boolean(raw),
        "time": _parse_time(str(raw.get("time", ""))).isoformat(),
        "weekdays": normalized_days,
        "message_source": normalize_message_source(
            raw.get("message_source", raw.get("message", ""))
        ),
        "speakers": _normalize_speakers(raw.get("speakers")),
    }


def normalize_routine(raw: dict[str, Any], *, routine_id: str | None = None) -> dict[str, Any]:
    """Validate a named routine and all of its steps."""
    _record(raw)
    name = _text(raw.get("name", ""), "routine name", limit=200)
    if not name:
        raise BellValidationError("routine name is required")
    raw_steps = raw.get("steps", [])
    if not isinstance(raw_steps, list) or len(raw_steps) > 1000:
        raise BellValidationError("routine steps must be a list")
    steps = [normalize_routine_step(step) for step in raw_steps]
    ids = [step["id"] for step in steps]
    if len(ids) != len(set(ids)):
        raise BellValidationError("routine step IDs must be unique")
    return {
        "id": _new_id(raw, routine_id),
        "name": name,
        "enabled": _boolean(raw),
        "steps": steps,
    }


def next_weekday_occurrence(
    weekdays: list[int], value: str, now_utc: datetime, tz: ZoneInfo
) -> datetime:
    """Return the next occurrence for an exact time on any selected weekday."""
    now_local = now_utc.astimezone(tz)
    parsed_time = _parse_time(value)
    candidates = []
    # Once per local date, first fold only; skip nonexistent spring-forward times.
    for offset in range(15):
        day = now_local.date() + timedelta(days=offset)
        if day.weekday() not in weekdays:
            continue
        candidate = datetime.combine(day, parsed_time, tz)
        utc = candidate.astimezone(UTC)
        if utc > now_utc and utc.astimezone(tz).replace(tzinfo=None) == candidate.replace(
            tzinfo=None
        ):
            candidates.append(utc)
    return min(candidates)


def next_occurrence(bell: dict[str, Any], now_utc: datetime, tz: ZoneInfo) -> datetime | None:
    """Return an independent bell's next UTC occurrence."""
    if not bell.get("enabled"):
        return None
    if bell["type"] == "one_time":
        if bell.get("status", "pending") != "pending":
            return None
        scheduled = _parse_datetime(bell["datetime"], tz).astimezone(UTC)
        return scheduled if scheduled > now_utc else None
    return next_weekday_occurrence([int(bell["weekday"])], bell["time"], now_utc, tz)


def extract_random_template(template: str) -> tuple[str, list[str]] | None:
    """Conservatively extract one literal Jinja random list and its wrapper."""
    matches = list(_RANDOM_EXPRESSION.finditer(template))
    if len(matches) != 1:
        return None
    try:
        values = ast.literal_eval(matches[0].group(1))
    except (SyntaxError, ValueError):
        return None
    if (
        not isinstance(values, list)
        or not values
        or not all(isinstance(value, str) and value.strip() for value in values)
    ):
        return None
    wrapper = (
        f"{template[: matches[0].start()]}{{{{ random_message }}}}{template[matches[0].end() :]}"
    )
    return wrapper.strip(), [value.strip() for value in values]


def advance_shuffle(
    enabled_ids: list[str],
    state: dict[str, Any],
    shuffle: Callable[[list[str]], None],
) -> str:
    """Advance a persisted shuffle bag and avoid a boundary repeat."""
    if not enabled_ids:
        raise BellValidationError("message set has no enabled messages")
    valid = set(enabled_ids)
    state["remaining"] = [item for item in state.get("remaining", []) if item in valid]
    if not state["remaining"]:
        state["remaining"] = list(enabled_ids)
        shuffle(state["remaining"])
        if len(state["remaining"]) > 1 and state["remaining"][0] == state.get("last"):
            state["remaining"][0], state["remaining"][1] = (
                state["remaining"][1],
                state["remaining"][0],
            )
    selected_id = state["remaining"].pop(0)
    state["last"] = selected_id
    return selected_id


def build_conversion_preview(
    bells: list[dict[str, Any]], bell_ids: list[str], name: str
) -> dict[str, Any]:
    """Build a deterministic, non-mutating routine-conversion proposal."""
    selected_ids = set(bell_ids)
    selected = [
        bell for bell in bells if bell.get("id") in selected_ids and bell.get("type") == "weekly"
    ]
    if not selected:
        raise BellValidationError("select at least one weekly bell")
    if len(selected) != len(selected_ids):
        raise BellValidationError("one or more selected weekly bells were not found")
    groups: dict[tuple[Any, ...], list[dict[str, Any]]] = defaultdict(list)
    for bell in selected:
        source = bell.get(
            "message_source", {"kind": "template", "template": bell.get("message", "")}
        )
        key = (
            bell["time"],
            bool(bell.get("enabled")),
            tuple(bell["speakers"]),
            source["kind"],
            source.get("set_id", ""),
            source["template"],
        )
        groups[key].append(bell)

    proposed_sets: list[dict[str, Any]] = []
    extracted_keys: dict[tuple[str, ...], str] = {}
    steps = []
    for index, (key, rows) in enumerate(sorted(groups.items(), key=lambda item: item[0])):
        bell_time, enabled, speakers, kind, set_id, template = key
        source: dict[str, str] = {"kind": kind, "template": template}
        if kind == "message_set":
            source["set_id"] = set_id
        elif extracted := extract_random_template(template):
            wrapper, variants = extracted
            variant_key = tuple(variants)
            proposal_key = extracted_keys.get(variant_key)
            if proposal_key is None:
                proposal_key = f"set-{len(proposed_sets) + 1}"
                extracted_keys[variant_key] = proposal_key
                proposed_sets.append(
                    {
                        "key": proposal_key,
                        "name": f"{name} messages {len(proposed_sets) + 1}",
                        "messages": [{"text": value, "enabled": True} for value in variants],
                    }
                )
            source = {"kind": "message_set", "set_key": proposal_key, "template": wrapper}
        steps.append(
            {
                "key": f"step-{index + 1}",
                "name": f"{str(bell_time)[:5]} bell",
                "enabled": enabled,
                "time": bell_time,
                "weekdays": sorted({int(row["weekday"]) for row in rows}),
                "message_source": source,
                "speakers": list(speakers),
                "source_bell_ids": sorted(row["id"] for row in rows),
            }
        )
    return {
        "routine": {"name": name.strip() or "Morning Routine", "enabled": True, "steps": steps},
        "message_sets": proposed_sets,
        "source_bell_ids": sorted(selected_ids),
    }


def sort_key(bell: dict[str, Any]) -> tuple[Any, ...]:
    """Stable UI sort key."""
    if bell["type"] == "weekly":
        return (0, bell["weekday"], bell["time"], bell["id"])
    return (1, bell["datetime"], bell["id"])
