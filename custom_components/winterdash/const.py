"""Constants for the WinterDash integration."""

from __future__ import annotations

DOMAIN = "winterdash"

# Discovery signature. Stamped by ESPHome from `esphome: project: { name: "winterdash.<board>" }`
# -> HA device registry manufacturer == "winterdash" (constant across every board/KIND; model = board).
MANUFACTURER = "winterdash"

# Baseline hero when no change-token entity is exposed yet (hero_ref absent AND banner_preset disabled).
# "Battery" is the always-present baked preset on every board -> /img/Battery is guaranteed to exist.
DEFAULT_HERO = "Battery"

# HTTP fetch budget (server-side, HA -> board). One request per hero change; never a timer poll.
FETCH_TIMEOUT_S = 15

# Defensive read cap. Hero WebP regions are 28-64 KB; a body far past that is not our hero
# (misconfig / wrong URL) -> reject rather than read an unbounded body into HA-host memory.
MAX_HERO_BYTES = 256 * 1024

# Companion Lovelace card (bundled inside the integration, served + auto-registered).
URL_BASE = "/winterdash"
CARD_FILENAME = "winterdash-card.js"
CARD_URL = f"{URL_BASE}/{CARD_FILENAME}"
