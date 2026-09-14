"""WinterDash hero image entity.

One bytes-mode ImageEntity per board. It fetches the board's dashboard hero (a WebP with
alpha, exactly what the LCD shows) from the board's own web server SERVER-SIDE (HA -> board,
so no browser mixed-content on an https HA) and serves it to the frontend via HA's
/api/image_proxy. WebP+alpha passes through byte-for-byte (content_type image/webp), so the
transparent vehicle cut-out survives — no PNG endpoint, no re-encode.

Device attach: the entity is re-homed onto the board's EXISTING ESPHome device (by its stable
MAC) via the entity registry — HA 2026.8.x cannot merge onto another integration's device via
`device_info` (that only makes a separate "link" device), so we set `device_id` after add.

Change-token (when to refetch) — feature-detected, forward-ready, CYD-polite:
  1. `sensor.<board>_hero_ref`  (v1 firmware, preferred) — its state IS the resolved hero
     path incl `?v=<crc>`: doubles as the precise change-token AND the baked-vs-custom URL.
  2. `select.<board>_banner_preset` (only if the user enabled that disabled-by-default entity)
     — baked name -> /img/<name>; "Custom" can't be resolved precisely without hero_ref.
  3. Baseline — /img/Battery, fetched once. (Both above absent/disabled.)
We refetch ONLY when the token entity's state changes (or on reload) — never on a timer, so
the memory-tight CYD is touched at most once per hero change. A lock serializes fetches so the
board's single-socket web server never sees overlapping requests.
"""

from __future__ import annotations

import asyncio
import logging

import aiohttp

from homeassistant.components.image import ImageEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.event import (
    EventStateChangedData,
    async_track_state_change_event,
)
from homeassistant.util import dt as dt_util

from .const import DEFAULT_HERO, FETCH_TIMEOUT_S, MAX_HERO_BYTES

_LOGGER = logging.getLogger(__name__)

_UNKNOWN_STATES = {None, "", "unknown", "unavailable"}

# WinterDash "plumbing" the card reads but the user shouldn't see on the device card. We HIDE
# these (hidden_by=INTEGRATION) — they stay ENABLED + readable (the card + automations still use
# them), only tucked out of the entity list. Matched by the frozen ESPHome object-id suffix.
# (The status readings, Status detail, Charger error, IP and the controls stay visible.)
_HIDE_SUFFIXES = (
    "_winterdash_hero_ref",
    "_winterdash_kind",
    "_winterdash_schema",
    "_winterdash_band_low",
    "_winterdash_band_high",
    "_winterdash_scale",
    "_device_state",   # the card surfaces this as the phase line -> redundant on the card
    "_demo_mode",      # the card has its own DEMO badge -> redundant
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the hero image for one board (identified by its stable MAC)."""
    mac: str = entry.data["mac"]
    device = dr.async_get(hass).async_get_device(
        connections={(dr.CONNECTION_NETWORK_MAC, mac)}
    )
    if device is None:
        _LOGGER.error("WinterDash board with MAC %s is not in the registry", mac)
        return
    async_add_entities([WinterDashHeroImage(hass, mac)])


class WinterDashHeroImage(ImageEntity):
    """The board's dashboard hero, mirrored into HA."""

    _attr_has_entity_name = True
    _attr_name = "Hero"
    _attr_content_type = "image/webp"

    def __init__(self, hass: HomeAssistant, mac: str) -> None:
        """Identify the board by its stable MAC (survives an ESPHome device re-add)."""
        super().__init__(hass)
        self._mac = mac
        self._attr_unique_id = f"{mac}_hero"
        self._cached: bytes | None = None
        self._token: str | None = None
        self._token_entity_id: str | None = None
        self._unsub = None
        self._reg_unsub = None
        self._lock = asyncio.Lock()
        self._alive = False
        self._curating = False
        self._tasks: set[asyncio.Task] = set()

    def _device(self) -> dr.DeviceEntry | None:
        """The board's ESPHome device, looked up by MAC (id-change proof)."""
        return dr.async_get(self.hass).async_get_device(
            connections={(dr.CONNECTION_NETWORK_MAC, self._mac)}
        )

    async def async_added_to_hass(self) -> None:
        """Re-home onto the ESPHome device, locate the token entity, first fetch."""
        await super().async_added_to_hass()
        self._alive = True
        device = self._device()
        if device is not None:
            # Put the Hero ON the board's ESPHome device card (not a separate device).
            # Idempotent: only write when it differs, so a re-entry never loops.
            ent_reg = er.async_get(self.hass)
            reg_entry = ent_reg.async_get(self.entity_id)
            if reg_entry is not None and reg_entry.device_id != device.id:
                ent_reg.async_update_entity(self.entity_id, device_id=device.id)
        self._ensure_token_watch()
        if device is not None:
            self._curate_device(device.id)
        # The ESPHome device may register its entities AFTER us on a restart, so hero_ref might
        # not exist yet. Watch the entity registry and adopt it the moment it lands (else we'd
        # stay stuck on the /img/Battery baseline until a reload).
        if self._token_entity_id is None:
            self._reg_unsub = self.hass.bus.async_listen(
                er.EVENT_ENTITY_REGISTRY_UPDATED, self._registry_updated
            )
        await self._refresh(initial=True)

    async def async_will_remove_from_hass(self) -> None:
        """Drop the subscriptions, cancel any in-flight fetch, stop writing state."""
        self._alive = False
        if self._unsub is not None:
            self._unsub()
            self._unsub = None
        if self._reg_unsub is not None:
            self._reg_unsub()
            self._reg_unsub = None
        for task in list(self._tasks):
            task.cancel()

    @callback
    def _ensure_token_watch(self) -> None:
        """Resolve the token entity (hero_ref) and (re)subscribe to its state changes."""
        device = self._device()
        if device is None:
            return
        eid = self._find_token_entity(device.id)
        if eid and eid != self._token_entity_id:
            if self._unsub is not None:
                self._unsub()
            self._token_entity_id = eid
            self._unsub = async_track_state_change_event(
                self.hass, [eid], self._token_changed
            )

    @callback
    def _registry_updated(self, event: Event) -> None:
        """Adopt hero_ref once it registers (restart race) + hide plumbing, then stop watching."""
        if self._token_entity_id is not None:
            return
        self._ensure_token_watch()
        device = self._device()
        if device is not None:
            self._curate_device(device.id)
        if self._token_entity_id is not None:
            if self._reg_unsub is not None:
                self._reg_unsub()
                self._reg_unsub = None
            self.hass.async_create_task(self._refresh())

    @callback
    def _curate_device(self, device_id: str) -> None:
        """Hide WinterDash plumbing from the device card (enabled + readable, just tucked away).

        Idempotent and respects a manual choice: skips any entity the user (or we) already set a
        `hidden_by` on, so unhiding one and it staying visible until the next fresh setup.
        """
        if self._curating:
            return
        self._curating = True
        try:
            ent_reg = er.async_get(self.hass)
            for ent in er.async_entries_for_device(ent_reg, device_id):
                if (
                    ent.hidden_by is None
                    and ent.platform == "esphome"  # only our board's firmware entities
                    and ent.entity_id.endswith(_HIDE_SUFFIXES)
                ):
                    ent_reg.async_update_entity(
                        ent.entity_id, hidden_by=er.RegistryEntryHider.INTEGRATION
                    )
        finally:
            self._curating = False

    def _find_token_entity(self, device_id: str) -> str | None:
        """Prefer hero_ref (v1), else an enabled banner_preset select.

        `async_entries_for_device` already excludes disabled entities, so a
        disabled-by-default `banner_preset` is skipped and we fall to the baseline.
        """
        ent_reg = er.async_get(self.hass)
        hero_ref: str | None = None
        banner: str | None = None
        for ent in er.async_entries_for_device(ent_reg, device_id):
            eid = ent.entity_id
            if eid.startswith("sensor.") and eid.endswith("_hero_ref"):
                hero_ref = eid
            elif eid.startswith("select.") and eid.endswith("_banner_preset"):
                banner = eid
        return hero_ref or banner

    def _current_base(self) -> str:
        """Re-read the board's web host from the registry each time (DHCP-proof).

        ESPHome keeps `configuration_url` fresh via zeroconf on an IP change; reading it
        per-fetch means a DHCP lease change doesn't strand us on a stale host.
        """
        device = self._device()
        if device is None:
            return ""
        return (device.configuration_url or "").rstrip("/")

    def _resolve(self, base: str) -> tuple[str, str]:
        """Resolve (url, token) for the current hero given the live host base."""
        if self._token_entity_id:
            state = self.hass.states.get(self._token_entity_id)
            if state is not None and state.state not in _UNKNOWN_STATES:
                val = state.state
                if self._token_entity_id.endswith("_hero_ref"):
                    # hero_ref carries the full path (e.g. "/img/Sedan" or
                    # "/gallery/hero?id=3&v=<crc>"); token == the path itself.
                    return f"{base}{val}", val
                if val != "Custom":
                    return f"{base}/img/{val}", val
        return f"{base}/img/{DEFAULT_HERO}", DEFAULT_HERO

    async def _refresh(self, *, initial: bool = False) -> None:
        """Fetch the hero if the token moved; bump image_last_updated on success.

        Serialized by a lock so the board's single-socket web server never sees two
        overlapping GETs. Waiters re-resolve the LATEST token inside the lock, so a burst
        of token changes collapses to one fetch of the final state.
        """
        async with self._lock:
            if not self._alive:
                return
            base = self._current_base()
            if not base:
                _LOGGER.warning(
                    "WinterDash %s: no configuration_url; cannot fetch the hero",
                    self._mac,
                )
                return
            url, token = self._resolve(base)
            if not initial and token == self._token and self._cached is not None:
                return

            session = async_get_clientsession(self.hass)
            try:
                async with session.get(
                    url, timeout=aiohttp.ClientTimeout(total=FETCH_TIMEOUT_S)
                ) as resp:
                    if resp.status != 200:
                        _LOGGER.warning(
                            "WinterDash hero fetch %s -> HTTP %s", url, resp.status
                        )
                        return
                    if not resp.content_type.startswith("image/"):
                        _LOGGER.warning(
                            "WinterDash hero fetch %s -> non-image %s",
                            url,
                            resp.content_type,
                        )
                        return
                    if (
                        resp.content_length is not None
                        and resp.content_length > MAX_HERO_BYTES
                    ):
                        _LOGGER.warning(
                            "WinterDash hero fetch %s -> %s bytes over cap",
                            url,
                            resp.content_length,
                        )
                        return
                    self._cached = await resp.read()
            except (aiohttp.ClientError, TimeoutError) as err:
                _LOGGER.warning("WinterDash hero fetch failed (%s): %s", url, err)
                return

            self._token = token
            if not self._alive:
                return
            self._attr_image_last_updated = dt_util.utcnow()
            self.async_write_ha_state()

    async def async_image(self) -> bytes | None:
        """Return the cached hero bytes (bytes-mode ImageEntity)."""
        return self._cached

    @callback
    def _token_changed(self, event: Event[EventStateChangedData]) -> None:
        """The hero change-token moved -> refetch (serialized + lifecycle-bound)."""
        task = self.hass.async_create_background_task(
            self._refresh(), name=f"winterdash_hero_refresh_{self._mac}"
        )
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
