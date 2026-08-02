"""Constants for HA Family Bell."""

from typing import Final

DOMAIN: Final = "ha_family_bell"
NAME: Final = "HA Family Bell"
PLATFORMS: Final = ["sensor", "switch"]

DATA_MANAGER: Final = "manager"
PANEL_URL_PATH: Final = "ha-family-bell"
PANEL_WEB_COMPONENT: Final = "ha-family-bell-panel"
STATIC_URL: Final = "/ha_family_bell/frontend"

STORE_KEY: Final = "ha_family_bell.schedule"
STORE_VERSION: Final = 2

EVENT_UPDATED: Final = "ha_family_bell_updated"
EVENT_FIRED: Final = "ha_family_bell_fired"

DEFAULT_SETTINGS: Final = {
    "tts_service": "tts.google_translate_say",
    "language": "en-gb",
    "intro_urls": [],
    "intro_delay": 4,
    "queue_hold_seconds": 3,
    "one_time_grace_seconds": 120,
}
