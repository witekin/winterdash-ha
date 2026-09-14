"""Config flow for WinterDash — auto-discover boards, pick one to mirror.

The ONLY config the user does: pick which already-added ESPHome WinterDash board to
monitor. Boards are discovered from the HA device registry by the constant discovery
marker `manufacturer == "winterdash"` (stamped by the firmware `project:` block), NOT by
per-board model — so charger/solar/monitor and any board all match one signature.
One config entry == one board == one hero widget (re-run the flow to add another board).

The board is keyed by its stable MAC (from the device's network-MAC connection), so the
config entry survives an ESPHome device re-add (which mints a new registry device id).
Only boards that expose an http(s) web server (a usable `configuration_url`) are offered,
since the hero is fetched from that host.
"""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers import device_registry as dr

from .const import DOMAIN, MANUFACTURER


def _mac_of(device: dr.DeviceEntry) -> str | None:
    """Return the device's network MAC (its stable hardware key), if any."""
    for conn_type, conn_value in device.connections:
        if conn_type == dr.CONNECTION_NETWORK_MAC:
            return conn_value
    return None


class WinterDashConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for WinterDash."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Pick a discovered WinterDash board that isn't configured yet."""
        dev_reg = dr.async_get(self.hass)
        configured = {
            entry.unique_id for entry in self._async_current_entries()
        }

        # mac -> "label (model)"
        choices: dict[str, str] = {}
        for device in dev_reg.devices.values():
            if (device.manufacturer or "").lower() != MANUFACTURER:
                continue
            mac = _mac_of(device)
            if mac is None or mac in configured:
                continue
            # The hero is fetched from configuration_url; skip boards without an http host.
            if not str(device.configuration_url or "").startswith("http"):
                continue
            label = device.name_by_user or device.name or mac
            model = device.model or "board"
            choices[mac] = f"{label} ({model})"

        if not choices:
            return self.async_abort(reason="no_devices")

        if user_input is not None:
            mac = user_input["device"]
            await self.async_set_unique_id(mac)
            self._abort_if_unique_id_configured()
            device = dev_reg.async_get_device(
                connections={(dr.CONNECTION_NETWORK_MAC, mac)}
            )
            title = (
                (device.name_by_user or device.name) if device else "WinterDash"
            ) or "WinterDash"
            return self.async_create_entry(title=title, data={"mac": mac})

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({vol.Required("device"): vol.In(choices)}),
        )
