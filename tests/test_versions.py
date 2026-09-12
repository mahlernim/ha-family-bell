"""Exercise the release-version consistency guard with isolated repositories."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tools.check_versions import check_versions

VERSION = "0.4.2"


def write_repository(root: Path) -> None:
    component = root / "custom_components" / "ha_family_bell"
    frontend = component / "frontend"
    frontend.mkdir(parents=True)
    (component / "manifest.json").write_text(json.dumps({"version": VERSION}), encoding="utf-8")
    (root / "pyproject.toml").write_text(f"[project]\nversion = {VERSION!r}\n", encoding="utf-8")
    (root / "package.json").write_text(json.dumps({"version": VERSION}), encoding="utf-8")
    (root / "package-lock.json").write_text(
        json.dumps({"version": VERSION, "packages": {"": {"version": VERSION}}}),
        encoding="utf-8",
    )
    (component / "__init__.py").write_text(
        f'URL = "ha-family-bell-panel.js?v={VERSION}"\n', encoding="utf-8"
    )
    (frontend / "ha-family-bell-panel.js").write_text(
        f'import "panel-model.js?v={VERSION}"\nconst css = "panel.css?v={VERSION}"\n',
        encoding="utf-8",
    )


def test_matching_versions_and_tag_pass(tmp_path: Path) -> None:
    write_repository(tmp_path)
    assert check_versions(tmp_path, "v0.4.2") == []


@pytest.mark.parametrize(
    ("relative", "old", "new", "expected_message"),
    [
        ("pyproject.toml", "0.4.2", "9.9.9", "pyproject.toml"),
        ("package.json", '"0.4.2"', '"9.9.9"', "package.json"),
        (
            "package-lock.json",
            '"version": "0.4.2"',
            '"version": "9.9.9"',
            "package-lock.json is",
        ),
        (
            "package-lock.json",
            '"packages": {"": {"version": "0.4.2"}}',
            '"packages": {"": {"version": "9.9.9"}}',
            'packages[""]',
        ),
        (
            "custom_components/ha_family_bell/__init__.py",
            "0.4.2",
            "9.9.9",
            "panel module cache key",
        ),
        (
            "custom_components/ha_family_bell/frontend/ha-family-bell-panel.js",
            "panel-model.js?v=0.4.2",
            "panel-model.js?v=9.9.9",
            "panel model cache key",
        ),
        (
            "custom_components/ha_family_bell/frontend/ha-family-bell-panel.js",
            "panel.css?v=0.4.2",
            "panel.css?v=9.9.9",
            "panel stylesheet cache key",
        ),
    ],
)
def test_each_version_location_reports_a_mismatch(
    tmp_path: Path, relative: str, old: str, new: str, expected_message: str
) -> None:
    write_repository(tmp_path)
    path = tmp_path / relative
    path.write_text(path.read_text(encoding="utf-8").replace(old, new, 1), encoding="utf-8")
    assert any(expected_message in error for error in check_versions(tmp_path))


def test_missing_cache_key_reports_an_error(tmp_path: Path) -> None:
    write_repository(tmp_path)
    path = tmp_path / "custom_components" / "ha_family_bell" / "__init__.py"
    path.write_text('URL = "ha-family-bell-panel.js"\n', encoding="utf-8")
    assert "panel module cache key is None, expected '0.4.2'" in check_versions(tmp_path)


def test_tag_mismatch_reports_expected_release_tag(tmp_path: Path) -> None:
    write_repository(tmp_path)
    assert check_versions(tmp_path, "v0.4.1") == ["release tag is 'v0.4.1', expected 'v0.4.2'"]
