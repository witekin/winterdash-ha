"""Test the WinterDash config flow.

The flow has one step: pick an already-added ESPHome WinterDash board (discovered by the
``manufacturer == "winterdash"`` marker, keyed by its network MAC, filtered to boards that
expose an http ``configuration_url``). These tests cover every branch: the discovery filter,
the ``no_devices`` abort, the happy path, and the duplicate ``already_configured`` guard.

The MAC addresses here are fabricated test values, not any real device.
"""

from __future__ import annotations

from collections.abc import Callable
from unittest.mock import patch

from homeassistant.config_entries import SOURCE_USER
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import device_registry as dr
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.winterdash.const import DOMAIN

MAC = "aa:bb:cc:dd:ee:01"
MAC2 = "aa:bb:cc:dd:ee:02"


async def _start(hass: HomeAssistant):
    """Kick off the user config flow."""
    return await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": SOURCE_USER}
    )


async def test_no_devices_aborts(hass: HomeAssistant) -> None:
    """With no WinterDash board in the registry, the flow aborts."""
    result = await _start(hass)

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "no_devices"


async def test_only_matching_boards_are_offered(
    hass: HomeAssistant, add_board: Callable[..., dr.DeviceEntry]
) -> None:
    """Non-WinterDash, MAC-less and non-http boards are filtered out of the picker."""
    add_board(MAC, name="Good Board")
    add_board("aa:bb:cc:dd:ee:03", manufacturer="acme", name="Other vendor")
    add_board(None, name="No MAC")
    add_board("aa:bb:cc:dd:ee:04", configuration_url=None, name="No web server")

    result = await _start(hass)

    assert result["type"] is FlowResultType.FORM
    selector = next(iter(result["data_schema"].schema.values()))
    assert set(selector.container) == {MAC}


async def test_full_flow_creates_entry(
    hass: HomeAssistant, add_board: Callable[..., dr.DeviceEntry]
) -> None:
    """Happy path: pick a board and an entry keyed by its MAC is created."""
    add_board(MAC, name="Garage WinterDash")

    result = await _start(hass)
    assert result["type"] is FlowResultType.FORM

    with patch(
        "custom_components.winterdash.async_setup_entry", return_value=True
    ):
        result2 = await hass.config_entries.flow.async_configure(
            result["flow_id"], {"device": MAC}
        )
        await hass.async_block_till_done()

    assert result2["type"] is FlowResultType.CREATE_ENTRY
    assert result2["title"] == "Garage WinterDash"
    assert result2["data"] == {"mac": MAC}
    assert result2["result"].unique_id == MAC


async def test_configured_board_not_offered(
    hass: HomeAssistant, add_board: Callable[..., dr.DeviceEntry]
) -> None:
    """A board that already has a config entry is not offered again -> abort."""
    add_board(MAC, name="Garage WinterDash")
    MockConfigEntry(domain=DOMAIN, unique_id=MAC, data={"mac": MAC}).add_to_hass(hass)

    result = await _start(hass)

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "no_devices"


async def test_duplicate_board_aborts(
    hass: HomeAssistant, add_board: Callable[..., dr.DeviceEntry]
) -> None:
    """A board configured between showing the form and submitting -> already_configured."""
    add_board(MAC, name="Board one")
    add_board(MAC2, name="Board two")

    result = await _start(hass)
    assert result["type"] is FlowResultType.FORM

    # Simulate the board being set up by another flow after the form was shown.
    MockConfigEntry(domain=DOMAIN, unique_id=MAC, data={"mac": MAC}).add_to_hass(hass)

    result2 = await hass.config_entries.flow.async_configure(
        result["flow_id"], {"device": MAC}
    )

    assert result2["type"] is FlowResultType.ABORT
    assert result2["reason"] == "already_configured"
