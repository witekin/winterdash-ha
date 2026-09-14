"""The WinterDash integration — mirrors a board's dashboard hero into Home Assistant.

PoC scope (charger v1): one hero ImageEntity per board, attached to the board's existing
ESPHome device. The status readouts (voltage/current/temp/status/phase) are ALREADY HA
entities from the ESPHome integration; this integration only adds the piece HA can't get
over the native API — the hero image — fetched server-side over HTTP, on-change only.
"""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryError
from homeassistant.loader import async_get_integration

from .const import DOMAIN
from .frontend import async_register_card

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.IMAGE]

_CARD_REGISTERED = f"{DOMAIN}_card_registered"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up WinterDash from a config entry (one entry == one board)."""
    if "mac" not in entry.data:
        # Pre-MAC entry shape ({"device_id": ...}); the board is now keyed by MAC.
        raise ConfigEntryError(
            "Outdated WinterDash entry — remove it and add the integration again"
        )
    # Serve + register the companion card once (not per board). A card problem must never gate the
    # hero entity (the integration's core purpose), so this is best-effort.
    if not hass.data.get(_CARD_REGISTERED):
        hass.data[_CARD_REGISTERED] = True
        try:
            integration = await async_get_integration(hass, DOMAIN)
            await async_register_card(hass, str(integration.version))
        except Exception:  # noqa: BLE001
            _LOGGER.exception(
                "WinterDash: card registration failed; the hero entity continues"
            )
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
