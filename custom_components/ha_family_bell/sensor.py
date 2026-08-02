"""Next Family Bell sensor."""

from datetime import datetime

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import DATA_MANAGER, DOMAIN
from .entity import FamilyBellEntity


async def async_setup_entry(
    hass: HomeAssistant,
    _entry: ConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    async_add_entities([FamilyBellNextSensor(hass.data[DOMAIN][DATA_MANAGER])])


class FamilyBellNextSensor(FamilyBellEntity, SensorEntity):
    """Timestamp and details for the next bell."""

    _attr_name = "Next bell"
    _attr_icon = "mdi:calendar-clock"
    _attr_unique_id = "ha_family_bell_next"
    _attr_device_class = SensorDeviceClass.TIMESTAMP

    @property
    def native_value(self) -> datetime | None:
        next_item = self.manager.next_bell()
        return datetime.fromisoformat(next_item["occurrence"]) if next_item else None

    @property
    def extra_state_attributes(self) -> dict:
        next_item = self.manager.next_bell()
        if not next_item:
            return {}
        bell = next_item["bell"]
        source = bell["message_source"]
        return {
            "bell_id": bell["id"],
            "message_template": source["template"],
            "message_set_id": source.get("set_id"),
            "speakers": bell["speakers"],
            "type": bell["type"],
            "routine_id": bell.get("routine_id"),
            "routine_name": bell.get("routine_name"),
            "step_id": bell.get("step_id"),
        }
