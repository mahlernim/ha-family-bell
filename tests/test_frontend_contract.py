"""Focused frontend source contracts that do not require a browser runtime."""

from pathlib import Path

PANEL_SOURCE = (
    Path(__file__).parents[1]
    / "custom_components"
    / "ha_family_bell"
    / "frontend"
    / "ha-family-bell-panel.js"
).read_text(encoding="utf-8")


def test_week_preview_shows_message_without_message_set_name() -> None:
    """Week Preview should show the template, leaving set selection to editors."""
    assert "previewMessageText(source)" in PANEL_SOURCE
    assert "return this.friendlyTemplate(source.template);" in PANEL_SOURCE
    assert "<span>Message</span><span>Speakers</span>" in PANEL_SOURCE
    assert (
        '<div class="preview-legend"><span>Time</span><span>Source</span><span>Message / set</span>'
    ) not in PANEL_SOURCE
    assert "return `Set: ${name}${extra}`;" not in PANEL_SOURCE
