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
_RANDOM_EXPRESSION = re.compile(r"{{\s*(\[(?:[^\[\]]|\n)*\])\s*\|\s*random\s*}}", re.DOTALL)


class BellValidationError(ValueError):
    """Raised when a Family Bell record is invalid."""


def expand_placeholders(template: str) -> str:
    """Translate friendly editor placeholders to Home Assistant templates."""
    for placeholder, expression in FRIENDLY_PLACEHOLDERS.items():
        template = template.replace(placeholder, expression)
    return template


def _new_id(raw: dict[str, Any], forced_id: str | None = None) -> str:
    return forced_id or str(raw.get("id") or uuid4())


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


def _normalize_speakers(value: Any) -> list[str]:
    if not isinstance(value, list) or not value:
        raise BellValidationError("at least one speaker is required")
    speakers = sorted({str(item).strip() for item in value if str(item).strip()})
    if not speakers or any(not item.startswith("media_player.") for item in speakers):
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
    template = expand_placeholders(str(raw.get("template", "")).strip())
    if not template:
        raise BellValidationError("message template is required")
    source = {"kind": kind, "template": template}
    if kind == "message_set":
        set_id = str(raw.get("set_id", "")).strip()
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
    bell_type = raw.get("type")
    if bell_type not in VALID_TYPES:
        raise BellValidationError("type must be weekly or one_time")
    source = normalize_message_source(raw.get("message_source", raw.get("message", "")))
    bell: dict[str, Any] = {
        "id": _new_id(raw, bell_id),
        "type": bell_type,
        "enabled": bool(raw.get("enabled", True)),
        "message_source": source,
        "speakers": _normalize_speakers(raw.get("speakers")),
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


def normalize_message_set(raw: dict[str, Any], *, set_id: str | None = None) -> dict[str, Any]:
    """Validate a reusable random-message set."""
    name = str(raw.get("name", "")).strip()
    if not name:
        raise BellValidationError("message set name is required")
    raw_items = raw.get("messages")
    if not isinstance(raw_items, list) or not raw_items:
        raise BellValidationError("message set must contain at least one message")
    items = []
    for item in raw_items:
        if isinstance(item, str):
            item = {"text": item}
        if not isinstance(item, dict):
            raise BellValidationError("message-set entries must be text records")
        text = str(item.get("text", "")).strip()
        if not text:
            raise BellValidationError("message-set text cannot be empty")
        items.append(
            {
                "id": _new_id(item),
                "text": text,
                "enabled": bool(item.get("enabled", True)),
            }
        )
    if not any(item["enabled"] for item in items):
        raise BellValidationError("message set must have at least one enabled message")
    return {"id": _new_id(raw, set_id), "name": name, "messages": items}


def normalize_routine_step(raw: dict[str, Any], *, step_id: str | None = None) -> dict[str, Any]:
    """Validate one exact-time routine step."""
    weekdays = raw.get("weekdays")
    if not isinstance(weekdays, list):
        raise BellValidationError("routine step weekdays must be a list")
    normalized_days = sorted({day for day in weekdays if isinstance(day, int)})
    if not normalized_days or any(day not in WEEKDAYS for day in normalized_days):
        raise BellValidationError("routine step needs at least one valid weekday")
    name = str(raw.get("name", "")).strip()
    return {
        "id": _new_id(raw, step_id),
        "name": name,
        "enabled": bool(raw.get("enabled", True)),
        "time": _parse_time(str(raw.get("time", ""))).isoformat(),
        "weekdays": normalized_days,
        "message_source": normalize_message_source(
            raw.get("message_source", raw.get("message", ""))
        ),
        "speakers": _normalize_speakers(raw.get("speakers")),
    }


def normalize_routine(raw: dict[str, Any], *, routine_id: str | None = None) -> dict[str, Any]:
    """Validate a named routine and all of its steps."""
    name = str(raw.get("name", "")).strip()
    if not name:
        raise BellValidationError("routine name is required")
    raw_steps = raw.get("steps", [])
    if not isinstance(raw_steps, list):
        raise BellValidationError("routine steps must be a list")
    steps = [normalize_routine_step(step) for step in raw_steps]
    ids = [step["id"] for step in steps]
    if len(ids) != len(set(ids)):
        raise BellValidationError("routine step IDs must be unique")
    return {
        "id": _new_id(raw, routine_id),
        "name": name,
        "enabled": bool(raw.get("enabled", True)),
        "steps": steps,
    }


def next_weekday_occurrence(
    weekdays: list[int], value: str, now_utc: datetime, tz: ZoneInfo
) -> datetime:
    """Return the next occurrence for an exact time on any selected weekday."""
    now_local = now_utc.astimezone(tz)
    parsed_time = _parse_time(value)
    candidates = []
    for weekday in weekdays:
        days_ahead = (weekday - now_local.weekday()) % 7
        candidate = datetime.combine(now_local.date() + timedelta(days=days_ahead), parsed_time, tz)
        if candidate <= now_local:
            candidate += timedelta(days=7)
        candidates.append(candidate.astimezone(UTC))
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
