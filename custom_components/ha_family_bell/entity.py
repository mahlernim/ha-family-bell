"""Base entity for HA Family Bell."""

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import Entity

from .const import DOMAIN, NAME
from .manager import FamilyBellManager


class FamilyBellEntity(Entity):
    """Common config-entry entity behavior."""

    _attr_has_entity_name = True

    def __init__(self, manager: FamilyBellManager) -> None:
        self.manager = manager
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, DOMAIN)},
            name=NAME,
            manufacturer="HA Family Bell",
            model="Scheduler",
        )

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            self.hass.bus.async_listen("ha_family_bell_updated", self._handle_update)
        )

    async def _handle_update(self, _event) -> None:
        self.async_write_ha_state()
