"""Check release-version consistency across Family Bell source files."""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE_KEYS = {
    "panel module": (
        "custom_components/ha_family_bell/__init__.py",
        r"ha-family-bell-panel\.js\?v=([^\"']+)",
    ),
    "panel model": (
        "custom_components/ha_family_bell/frontend/ha-family-bell-panel.js",
        r"panel-model\.js\?v=([^\"']+)",
    ),
    "panel stylesheet": (
        "custom_components/ha_family_bell/frontend/ha-family-bell-panel.js",
        r"panel\.css\?v=([^\"']+)",
    ),
}


def _read_json(root: Path, relative: str) -> dict:
    return json.loads((root / relative).read_text(encoding="utf-8"))


def check_versions(root: Path = ROOT, tag: str | None = None) -> list[str]:
    """Return consistency errors for a repository root and optional release tag."""
    manifest = _read_json(root, "custom_components/ha_family_bell/manifest.json")
    expected = manifest["version"]
    pyproject = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    package = _read_json(root, "package.json")
    lock = _read_json(root, "package-lock.json")
    versions = {
        "pyproject.toml": pyproject["project"]["version"],
        "package.json": package["version"],
        "package-lock.json": lock["version"],
        'package-lock.json packages[""]': lock["packages"][""]["version"],
    }
    errors = [
        f"{name} is {value!r}, expected {expected!r}"
        for name, value in versions.items()
        if value != expected
    ]
    for name, (relative, pattern) in CACHE_KEYS.items():
        text = (root / relative).read_text(encoding="utf-8")
        match = re.search(pattern, text)
        value = match.group(1) if match else None
        if value != expected:
            errors.append(f"{name} cache key is {value!r}, expected {expected!r}")
    if tag is not None:
        expected_tag = f"v{expected}"
        if tag != expected_tag:
            errors.append(f"release tag is {tag!r}, expected {expected_tag!r}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", help="Release tag to validate, for example v0.4.2")
    args = parser.parse_args()
    errors = check_versions(tag=args.tag)
    if errors:
        print("Release version check failed:", file=sys.stderr)
        print(*errors, sep="\n", file=sys.stderr)
        return 1
    print("Release versions are consistent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
