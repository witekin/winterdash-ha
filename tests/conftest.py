"""Shared fixtures for the WinterDash tests."""

from __future__ import annotations

from collections.abc import Callable

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Load the WinterDash custom integration in every test."""
    yield


@pytest.fixture(autouse=True)
def bypass_frontend_dependency(hass: HomeAssistant) -> None:
    """Mark ``frontend`` as already set up.

    The integration hard-depends on ``frontend`` for the bundled Lovelace card, so starting the
    config flow would otherwise try to set it up — but ``frontend`` needs the compiled
    ``hass_frontend`` package, which isn't installed in the test environment. The config flow
    uses no frontend API, so we mark it loaded to skip that dependency setup.
    """
    hass.config.components.add("frontend")


@pytest.fixture
def add_board(hass: HomeAssistant) -> Callable[..., dr.DeviceEntry]:
    """Return a helper that registers a board-like device in the registry.

    Mirrors what the ESPHome integration would create for a WinterDash board: a device with
    ``manufacturer == "winterdash"``, a network-MAC connection, and an http ``configuration_url``.
    The config flow discovers boards purely from these registry fields.
    """
    device_registry = dr.async_get(hass)

    def _add(
        mac: str | None,
        *,
        manufacturer: str = "winterdash",
        configuration_url: str | None = "http://winterdash.local",
        name: str = "WinterDash Board",
        model: str = "tdisplay",
    ) -> dr.DeviceEntry:
        host = MockConfigEntry(domain="esphome")
        host.add_to_hass(hass)
        connections = (
            {(dr.CONNECTION_NETWORK_MAC, mac)} if mac is not None else set()
        )
        return device_registry.async_get_or_create(
            config_entry_id=host.entry_id,
            identifiers={("esphome", name)},
            connections=connections,
            manufacturer=manufacturer,
            name=name,
            model=model,
            configuration_url=configuration_url,
        )

    return _add
