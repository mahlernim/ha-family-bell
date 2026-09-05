"""Master enable switch."""

from homeassistant.components.switch import SwitchEntity
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
    async_add_entities([FamilyBellMasterSwitch(hass.data[DOMAIN][DATA_MANAGER])])


class FamilyBellMasterSwitch(FamilyBellEntity, SwitchEntity):
    """Globally enable or pause all bells."""

    _attr_translation_key = "schedule"
    _attr_icon = "mdi:bell-ring"
    _attr_unique_id = "ha_family_bell_schedule"

    @property
    def is_on(self) -> bool:
        return self.manager.global_enabled

    async def async_turn_on(self, **_kwargs) -> None:
        await self.manager.async_set_global_enabled(True)

    async def async_turn_off(self, **_kwargs) -> None:
        await self.manager.async_set_global_enabled(False)
