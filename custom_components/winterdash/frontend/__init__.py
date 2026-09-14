"""Serve the WinterDash Lovelace card and auto-register it as a dashboard resource.

The card is a single hand-authored ES module (no build step) that ships inside the integration.
We serve the frontend/ directory over HTTP and, on a storage-mode dashboard, register the card as
a JavaScript-module resource so the user never adds it manually. YAML-mode dashboards can't be
auto-registered (the resource collection is read-only there) — we log the URL for a manual add.
"""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import Event, HomeAssistant

from ..const import CARD_URL, URL_BASE

_LOGGER = logging.getLogger(__name__)


async def async_register_card(hass: HomeAssistant, version: str) -> None:
    """Serve the card directory and register the Lovelace resource (once)."""
    await hass.http.async_register_static_paths(
        [StaticPathConfig(URL_BASE, str(Path(__file__).parent), False)]
    )
    if hass.is_running:
        await _async_register_resource(hass, version)
    else:
        async def _on_start(_event: Event) -> None:
            await _async_register_resource(hass, version)

        hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _on_start)


async def _async_register_resource(hass: HomeAssistant, version: str) -> None:
    """Add/update the card as a module resource on a storage-mode dashboard.

    HA 2026.8.x `LovelaceData` exposes the resources mode as `resource_mode` (older cores used
    `mode`); reading the wrong name is why this silently no-ops. `hass.data["lovelace"]` (==
    the LOVELACE_DATA HassKey) + `.resources` (a ResourceStorageCollection) is the browser_mod
    path — it's what makes the entry appear in Settings -> Dashboards -> Resources.
    """
    url = f"{CARD_URL}?v={version}"
    try:
        lovelace = hass.data.get("lovelace")
        if lovelace is None:
            _LOGGER.info("Lovelace not set up; add %s manually as a resource", CARD_URL)
            return
        mode = getattr(lovelace, "resource_mode", None) or getattr(lovelace, "mode", None)
        resources = getattr(lovelace, "resources", None)
        if mode != "storage" or resources is None:
            _LOGGER.info(
                "WinterDash card served at %s; resources are in %s mode -> add it manually "
                "as a JavaScript-module resource.",
                url,
                mode,
            )
            return
        # Force-load the storage collection before iterating (async_get_info wraps the guarded
        # ensure-loaded); async_create_item also ensures loaded on its own.
        if not getattr(resources, "loaded", False):
            if hasattr(resources, "async_get_info"):
                await resources.async_get_info()
            else:
                await resources.async_load()
                resources.loaded = True
        for item in resources.async_items():
            if str(item.get("url", "")).startswith(CARD_URL):
                if item.get("url") != url:
                    await resources.async_update_item(
                        item["id"], {"res_type": "module", "url": url}
                    )
                    _LOGGER.info("Updated the WinterDash card resource to %s", url)
                return
        await resources.async_create_item({"res_type": "module", "url": url})
        _LOGGER.info("Registered the WinterDash card resource %s", url)
    except Exception as err:  # noqa: BLE001 — never let a lovelace-internals change break setup
        _LOGGER.warning(
            "WinterDash: could not auto-register the card resource (%s). "
            "Add it manually as a JS-module resource: %s",
            err,
            url,
        )
