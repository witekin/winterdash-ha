/*
 * WinterDash card — a 1:1 mirror of a WinterDash board's dashboard screen in Home Assistant.
 *
 * Self-contained, dependency-free, NO build step: this single ES module IS the shipped artifact
 * (the integration serves it and auto-registers the Lovelace resource). Vanilla custom element
 * (build-once + update-in-place), themed entirely through Home Assistant CSS custom properties,
 * container-query scaled so it resizes like a native card.
 *
 * Config = one thing: `device` (a WinterDash device id). Entities are resolved from that device by
 * stable ROLE -> frozen ESPHome object-id (append-only covenant), feature-detected + degrading
 * gracefully, so older firmware / a future KIND that omits a role just skips it. The hero image is
 * the integration-created image entity (served via /api/image_proxy).
 *
 * Clicking a readout opens HA's native more-info (history/logbook) — zero board polling, HA already
 * holds the data. English-only strings live in STR (one place, i18n-ready if there's ever demand).
 */

const CARD_VERSION = "0.1.2";

// All user-facing card strings in one place (en-only; centralized so a future i18n is a small change).
const STR = {
  brand: "WinterDash",
  demo: "DEMO",
  pick: "Select a WinterDash device",
  editorDevice: "WinterDash board",
  histHint: "click for history",
  offBoard: "Board offline",
  offSignal: "No signal — charger off or out of range",
  fault: "Check charger",
};

/* Role -> how to find the entity on the device. `suffix` matches the ESPHome entity_id object-id
 * (frozen names, see docs/internal/ha-screen-mirror-plan.md). `image` role = our integration's
 * hero image entity (domain image, our platform). Append-only: never repurpose a role. */
const ROLES = {
  hero:         { domain: "image", platform: "winterdash" },
  status:       { domain: "sensor", suffix: "status" },
  status_note:  { domain: "sensor", suffix: "status_detail" },
  device_state: { domain: "sensor", suffix: "device_state" },
  charger_error:{ domain: "sensor", suffix: "charger_error" },
  voltage:      { domain: "sensor", suffix: "battery_voltage" },
  current:      { domain: "sensor", suffix: "battery_current" },
  temperature:  { domain: "sensor", suffix: "charger_temperature" },
  demo:         { domain: "binary_sensor", suffix: "demo_mode" },
  band_low:     { domain: "sensor", suffix: "winterdash_band_low" },
  band_high:    { domain: "sensor", suffix: "winterdash_band_high" },
  scale:        { domain: "sensor", suffix: "winterdash_scale" },
};

/* Status word -> glyph + semantic colour token + whether it's an "overlay" (dimmed hero + centered
 * word, like the LCD's fault/offline takeover). Everything else falls through to IDLE. */
const STATES = {
  CHARGING: { icon: "bolt",  color: "var(--state-charging, #ff9800)" },
  RECOND:   { icon: "bolt",  color: "var(--state-charging, #ff9800)" },
  CHARGED:  { icon: "check", color: "var(--state-charged, #43a047)" },
  IDLE:     { icon: "sleep", color: "var(--state-idle, var(--secondary-text-color))" },
  FAULT:    { icon: "alert", color: "var(--state-fault, var(--error-color, #d32f2f))", overlay: true },
  OFFLINE:  { icon: "sleep", color: "var(--state-offline, #78909c)", overlay: true },
};

const AX_LO = 9.5, AX_HI = 15.5;         // range-bar voltage axis (× scale)
const UNAVAIL = new Set([undefined, null, "", "unknown", "unavailable"]);

const GLYPHS = {
  bolt:  '<path d="M13 2 3 14h7l-1 8 11-13h-8z" fill="currentColor"/>',
  check: '<path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" fill="currentColor"/>',
  sleep: '<path d="M4 12a8 8 0 1 0 8-8 6.5 6.5 0 0 1-8 8z" fill="currentColor"/>',
  alert: '<path d="M12 2 1 21h22z M11 10h2v5h-2z M11 17h2v2h-2z" fill="currentColor"/>',
  amp:   '<path d="M4 12h4l2-6 4 12 2-6h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  temp:  '<path d="M12 3a2 2 0 0 1 2 2v9a4 4 0 1 1-4 0V5a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
};
const svg = (g) => `<svg viewBox="0 0 24 24">${GLYPHS[g]}</svg>`;

const num = (s, dp) => {
  const v = Number(s);
  return Number.isFinite(v) ? v.toFixed(dp) : "—";
};

// Coarse relative time for the offline "last seen" (no board poll; refreshed by a slow timer).
const relTime = (iso) => {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!(ms >= 0)) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
};

class WinterDashCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._built = false;
    this._sig = "";       // signature of relevant state -> gate re-render
    this._map = null;     // role -> entity_id
    this._mapDevice = null;
    this._offTimer = null;
    this._offBase = "";
    this._offSince = null;
  }

  setConfig(config) {
    if (!config || typeof config !== "object") {
      throw new Error("WinterDash: invalid card configuration");
    }
    // An empty `device` is the initial editor/preview state -> render a placeholder rather
    // than throwing (keeps the card picker preview + a freshly-added card graceful).
    this._config = config;
    this._map = null;     // force re-resolve on next hass
    this._sig = "";
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    if (!this._built) this._build();
    if (!this._config.device) { this._placeholder(); return; }
    // Resolve the role->entity map from the in-memory registry maps. Re-resolve until the core
    // roles are found, so an entity that registers slightly later (or a firmware update that adds
    // a role) is picked up without an editor round-trip.
    if (!this._map || this._mapDevice !== this._config.device
        || !this._map.status || !this._map.hero) this._resolve();
    // Gate: only touch the DOM when a value we render actually changed.
    const sig = this._signature();
    if (sig !== this._sig) { this._sig = sig; this._update(); }
  }

  disconnectedCallback() { this._clearOffTimer(); }

  connectedCallback() {
    // Force a full re-render on the next hass after a re-attach (drag-reorder / wrapper card) so the
    // offline "X ago" timer + values re-establish even if the state didn't change while detached.
    this._sig = "";
  }

  _placeholder() {
    const el = this._el;
    this._clearOffTimer();
    el.wd.classList.remove("dimmed");
    el.hero.style.visibility = "hidden";
    el.overlay.hidden = false;
    el.cluster.style.visibility = "hidden";
    el.bar.style.visibility = "hidden";
    el.bottom.style.visibility = "hidden";  // keep the empty amp/temp chips out of the placeholder grid
    el.vname.hidden = true;
    el.demo.hidden = true;
    el.ow.textContent = STR.brand;
    el.ow.style.color = "var(--secondary-text-color)";
    el.os.textContent = STR.pick;
    this._sig = "";
  }

  _resolve() {
    const hass = this._hass, dev = this._config.device;
    this._mapDevice = dev;
    const map = {};
    const ents = hass.entities || {};
    for (const [eid, e] of Object.entries(ents)) {
      if (e.device_id !== dev) continue;
      const domain = eid.slice(0, eid.indexOf("."));
      for (const [role, r] of Object.entries(ROLES)) {
        if (map[role]) continue;
        if (r.domain && r.domain !== domain) continue;
        if (r.platform && e.platform !== r.platform) continue;
        if (r.suffix && !eid.endsWith("_" + r.suffix)) continue;
        map[role] = eid;
      }
    }
    this._map = map;
  }

  _st(role) {                                   // state object for a role, or undefined
    const eid = this._map && this._map[role];
    return eid ? this._hass.states[eid] : undefined;
  }
  _val(role) {                                  // state string, or undefined if unavailable
    const s = this._st(role);
    return s && !UNAVAIL.has(s.state) ? s.state : undefined;
  }

  _signature() {
    // roles whose value affects the render
    const keys = ["hero","status","status_note","device_state","charger_error","voltage",
                  "current","temperature","demo","band_low","band_high","scale"];
    let sig = "";
    for (const k of keys) {
      const s = this._st(k);
      if (!s) { sig += "|"; continue; }
      sig += "|" + s.state;
      if (k === "hero") sig += "@" + (s.attributes.entity_picture || "");
    }
    // device friendly-name (vehicle label) also affects the render
    const dev = this._hass.devices && this._hass.devices[this._config.device];
    sig += "#" + (dev ? (dev.name_by_user || dev.name || "") : "");
    return sig;
  }

  _build() {
    this.shadowRoot.innerHTML = `<style>${STYLE}</style>
      <div class="wd">
        <div class="content">
          <img class="hero" alt="">
          <div class="corner">
            <div class="vname" hidden></div>
            <div class="demo" hidden>${STR.demo}</div>
          </div>
          <div class="cluster">
            <div class="status"><span class="sicon"></span><span class="sword"></span></div>
            <div class="volt"><span class="vnum"></span><small>V</small></div>
            <div class="phase"></div>
          </div>
          <div class="bar"><svg viewBox="0 0 100 9" preserveAspectRatio="none">
            <rect class="track" x="0" y="2" width="100" height="5" rx="2.5"></rect>
            <rect class="red-lo" y="2" height="5" rx="2.5"></rect>
            <rect class="red-hi" y="2" height="5" rx="2.5"></rect>
            <rect class="band"  y="1.2" height="6.6" rx="2.5"></rect>
            <rect class="mark"  y="-1" width="1.4" height="11" rx="0.7"></rect>
          </svg></div>
          <div class="bottom">
            <div class="b b-amp">${svg("amp")}<span class="amp"></span></div>
            <div class="b b-temp">${svg("temp")}<span class="temp"></span></div>
          </div>
        </div>
        <div class="overlay" hidden><div class="obox"><div class="ow"></div><div class="os"></div></div></div>
      </div>`;
    const $ = (s) => this.shadowRoot.querySelector(s);
    this._el = {
      wd:$(".wd"), hero:$(".hero"), overlay:$(".overlay"), ow:$(".ow"), os:$(".os"),
      vname:$(".vname"), demo:$(".demo"), cluster:$(".cluster"),
      status:$(".status"), sicon:$(".sicon"), sword:$(".sword"),
      volt:$(".volt"), vnum:$(".vnum"), phase:$(".phase"),
      bar:$(".bar"), redLo:$(".red-lo"), redHi:$(".red-hi"), band:$(".band"), mark:$(".mark"),
      bottom:$(".bottom"), bAmp:$(".b-amp"), amp:$(".amp"), bTemp:$(".b-temp"), temp:$(".temp"),
    };
    this._el.hero.addEventListener("error", () => { this._el.hero.style.visibility = "hidden"; });
    // Click / keyboard -> HA native more-info (history). Chip is the hit target; role resolved at
    // event time so a missing role just no-ops.
    this._clickTargets = [
      [this._el.status, "status"], [this._el.volt, "voltage"], [this._el.phase, "device_state"],
      [this._el.bAmp, "current"], [this._el.bTemp, "temperature"],
    ];
    for (const [node, role] of this._clickTargets) {
      node.addEventListener("click", () => this._moreInfo(role));
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this._moreInfo(role); }
      });
    }
    this._built = true;
  }

  _moreInfo(role) {
    const eid = this._map && this._map[role];
    if (!eid) return;
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      detail: { entityId: eid }, bubbles: true, composed: true,
    }));
  }

  _update() {
    const el = this._el, hass = this._hass;

    // ---- status word (drives icon, colour, overlay) ----
    const word = (this._val("status") || "OFFLINE").toUpperCase();
    const stt = STATES[word] || STATES.IDLE;
    const overlay = !!stt.overlay;

    // ---- vehicle name (from the HA device friendly-name; renamed in HA = renamed here) ----
    const dev = hass.devices && hass.devices[this._config.device];
    const vname = dev && (dev.name_by_user || dev.name);
    el.vname.textContent = vname || "";
    el.vname.hidden = !vname;

    // ---- hero ----
    const heroS = this._st("hero");
    const pic = heroS && heroS.attributes.entity_picture;
    if (pic) {
      // The image_proxy entity_picture token doesn't rotate when the hero BYTES change, so pointing
      // the <img> at the same URL serves the cached (stale) hero until a full reload. Bust on
      // image_last_updated (bumped by the integration on a hero change) so a live switch re-fetches.
      // Skip for a data: URI — it's already content-unique and a query param would corrupt it.
      el.hero.src = pic.startsWith("data:")
        ? pic
        : pic + (pic.includes("?") ? "&" : "?") + "wdts=" + encodeURIComponent(heroS.state || "");
      el.hero.style.visibility = "";
    } else {
      el.hero.style.visibility = "hidden";
    }
    el.wd.classList.toggle("dimmed", overlay);

    // ---- overlay (FAULT / OFFLINE takeover) ----
    el.overlay.hidden = !overlay;
    el.cluster.style.visibility = overlay ? "hidden" : "";
    el.bar.style.visibility = overlay ? "hidden" : "";
    el.bottom.style.visibility = overlay ? "hidden" : "";
    if (overlay) {
      el.ow.textContent = word;
      el.ow.style.color = stt.color;
      if (word === "OFFLINE") {
        // Distinguish board-down (status entity unavailable) from charger-no-signal (status="OFFLINE"),
        // + a coarse "last seen" so a remote user tells a wifi blip from a days-old dropout.
        const s = this._st("status");
        const boardOffline = !s || UNAVAIL.has(s.state);
        this._offBase = boardOffline ? STR.offBoard : STR.offSignal;
        this._offSince = s ? s.last_changed : null;
        this._renderOffline();
        this._ensureOffTimer();
      } else {
        this._clearOffTimer();
        el.os.textContent = this._val("charger_error") || this._val("status_note") || STR.fault;
      }
    } else {
      this._clearOffTimer();
    }

    // ---- status cluster ----
    el.sicon.innerHTML = svg(stt.icon);
    el.status.style.color = stt.color;
    el.sword.textContent = word;
    const v = this._val("voltage");
    el.vnum.textContent = v ? num(v, 2) : "—";
    const phase = this._val("device_state") || this._val("status_note") || "";
    el.phase.textContent = phase;

    // ---- DEMO badge ----
    el.demo.hidden = this._val("demo") !== "on";

    // ---- range bar ----
    if (!overlay) this._bar();

    // ---- bottom readouts ----
    const a = this._val("current"), t = this._val("temperature");
    el.amp.textContent = a != null ? `${num(a,1)} A` : "— A";
    el.temp.textContent = t != null ? `${Math.round(Number(t))}°C` : "—";

    // ---- interaction affordance + tooltips/aria (only where the role resolved) ----
    const sinceClock = (role) => {
      const s = this._st(role);
      if (!s || !s.last_changed) return "";
      const d = new Date(s.last_changed);
      return ` · since ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    };
    this._afford(el.status, "status", `Status ${word}, show history`, `${word}${sinceClock("status")}`);
    this._afford(el.volt, "voltage", `Battery voltage ${el.vnum.textContent} volts, show history`,
      `Battery voltage · ${STR.histHint}`);
    this._afford(el.phase, "device_state", `Charge phase ${phase}, show history`,
      `${phase || "Phase"}${sinceClock("device_state")}`);
    this._afford(el.bAmp, "current", `Battery current ${el.amp.textContent}, show history`,
      `Battery current · ${STR.histHint}`);
    this._afford(el.bTemp, "temperature", `Charger temperature ${el.temp.textContent}, show history`,
      `Charger temperature · ${STR.histHint}`);
  }

  _afford(node, role, ariaLabel, title) {
    const on = !!(this._map && this._map[role]);
    node.classList.toggle("clickable", on);
    node.title = on ? title : "";
    if (on) {
      node.setAttribute("role", "button");
      node.setAttribute("tabindex", "0");
      node.setAttribute("aria-label", ariaLabel);
    } else {
      node.removeAttribute("role");
      node.removeAttribute("tabindex");
      node.removeAttribute("aria-label");
    }
  }

  _renderOffline() {
    const since = relTime(this._offSince);
    this._el.os.textContent = since ? `${this._offBase} · ${since}` : this._offBase;
  }
  _ensureOffTimer() {
    if (!this._offTimer) this._offTimer = setInterval(() => this._renderOffline(), 60000);
  }
  _clearOffTimer() {
    if (this._offTimer) { clearInterval(this._offTimer); this._offTimer = null; }
  }

  _bar() {
    const el = this._el;
    const sc = Number(this._val("scale")) || 1;
    const lo = AX_LO * sc, hi = AX_HI * sc, span = hi - lo;
    const pc = (x) => Math.max(0, Math.min(100, (x - lo) / span * 100));
    const redLoV = 10.5 * sc, redHiV = 15.3 * sc;
    el.redLo.setAttribute("x", 0);
    el.redLo.setAttribute("width", pc(redLoV).toFixed(1));
    el.redHi.setAttribute("x", pc(redHiV).toFixed(1));
    el.redHi.setAttribute("width", (100 - pc(redHiV)).toFixed(1));

    const bl = this._val("band_low"), bh = this._val("band_high");
    if (bl != null && bh != null) {
      const a = pc(Number(bl)), b = pc(Number(bh));
      el.band.style.display = "";
      el.band.setAttribute("x", a.toFixed(1));
      el.band.setAttribute("width", Math.max(0, b - a).toFixed(1));
    } else el.band.style.display = "none";

    const v = this._val("voltage");
    if (v != null) {
      el.mark.style.display = "";
      el.mark.setAttribute("x", (pc(Number(v)) - 0.7).toFixed(1));
    } else el.mark.style.display = "none";
  }

  getCardSize() { return 3; }
  getGridOptions() { return { rows: 3, columns: 6, min_rows: 2, min_columns: 4 }; }

  static getConfigElement() { return document.createElement("winterdash-card-editor"); }
  static getStubConfig(hass) {
    // default to the first WinterDash device, if any
    const dev = Object.values(hass.devices || {}).find(
      (d) => (d.manufacturer || "").toLowerCase() === "winterdash");
    return { device: dev ? dev.id : "" };
  }
}

class WinterDashCardEditor extends HTMLElement {
  setConfig(config) { this._config = config; this._render(); }
  set hass(hass) { this._hass = hass; this._render(); }

  _render() {
    if (!this._hass) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.addEventListener("value-changed", (ev) => {
        this.dispatchEvent(new CustomEvent("config-changed", {
          detail: { config: ev.detail.value }, bubbles: true, composed: true,
        }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.data = this._config || {};
    this._form.schema = [
      { name: "device", required: true,
        selector: { device: { filter: { integration: "winterdash" } } } },
    ];
    this._form.computeLabel = (s) => (s.name === "device" ? STR.editorDevice : s.name);
  }
}

customElements.define("winterdash-card", WinterDashCard);
customElements.define("winterdash-card-editor", WinterDashCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "winterdash-card",
  name: STR.brand,
  description: "Mirrors a WinterDash board's dashboard screen (hero + status + range bar).",
  preview: true,
  documentationURL: "https://github.com/witekin/winterdash-ha",
});

console.info(
  `%c WINTERDASH-CARD %c v${CARD_VERSION} `,
  "color:#fff;background:#3ea0a0;border-radius:3px 0 0 3px;padding:2px 4px",
  "color:#3ea0a0;background:#222;border-radius:0 3px 3px 0;padding:2px 4px"
);

const STYLE = `
  :host{display:block;height:100%}
  .wd{position:relative;width:100%;height:100%;min-height:150px;aspect-ratio:16/9;
    background:var(--ha-card-background,var(--card-background-color,#fff));
    border-radius:var(--ha-card-border-radius,12px);
    box-shadow:var(--ha-card-box-shadow,0 2px 6px rgba(0,0,0,.18));
    border:var(--ha-card-border-width,1px) solid var(--ha-card-border-color,var(--divider-color,transparent));
    overflow:hidden;container-type:size;font-variant-numeric:tabular-nums;
    color:var(--primary-text-color);font-family:var(--paper-font-body1_-_font-family,Roboto,system-ui,sans-serif);
    /* Legibility scrim used ONLY by the phase line — it's the sole readout the hero can sit behind
       (rows 3-4). A soft translucent wash of the CARD colour: invisible on the card itself (so it's
       not a boxy chip when the phase is above the hero), a gentle dark/light backing over the car.
       Every other readout is above/below the hero -> no backing at all. */
    --wd-chip:color-mix(in srgb, var(--ha-card-background,var(--card-background-color,#fff)) 55%, transparent)}

  /* ONE fixed layout at every size (no aspect breakpoints — those proved unreliable on HA's non-square
     grid cells). Explicit 6-row grid; the readout ROLES never move:
        row 1  name+DEMO (left)   |  STATUS word (right)     <- car-free: the hero never reaches row 1
        row 2  (hero)             |  big VOLTAGE (right)
        row 3  (hero)             |  PHASE (right)
        row 4  (hero, 1fr fill)
        row 5  range BAR (full width)
        row 6  A / °C (full width)
     The hero car is a big BACKGROUND spanning rows 3-4 (phase + fill), grounded at the bar. So it can
     rise behind the PHASE (its chip keeps it legible) but can NEVER cover the big VOLTAGE, the status
     word or the vehicle name (rows 1-2 are above the hero's grid area). On a very tall card the
     width-bound car sits low and leaves clear space above it — intended. */
  .content{position:absolute;inset:0;z-index:2;display:grid;gap:1.2cqh 3cqw;padding:4.2cqh 5cqw;
    grid-template:
      "name    status" auto
      ".       volt"   auto
      ".       phase"  auto
      ".       ."      minmax(0,1fr)
      "bar     bar"    auto
      "bottom  bottom" auto / 1fr 1fr;
    justify-items:stretch;align-content:stretch}
  .hero{grid-column:1 / -1;grid-row:3 / 5;justify-self:stretch;align-self:stretch;width:100%;height:100%;
    min-height:0;object-fit:contain;object-position:center center;z-index:-1}
  /* object-position:center center (not bottom): the hero is CENTERED in its cell so the whitespace
     is even top+bottom whatever the image's aspect. A wide/short cut-out (boat) is otherwise jammed
     against the bar with a big gap above it, while a tall one (motorcycle) fills it — centering
     balances both. z-index:-1, NOT 0: a grid item with z-index:0 paints ABOVE its z-index:auto
     siblings (grid/flex items make a stacking context at 0), which would put the car OVER the phase/
     readout chips. -1 forces it below every readout so their chips always paint on top. */
  .wd.dimmed .hero{filter:grayscale(.75);opacity:.4}

  /* vehicle name + DEMO badge (row 1, left) — plain text: they sit above the hero, never over it, so
     no backing chip. Pinned top-left; flex-wrap drops DEMO under a too-long name. DEMO keeps its
     outline (it's a badge, not a chip). */
  .corner{grid-area:name;align-self:start;justify-self:start;display:flex;flex-flow:row wrap;align-items:center;
    gap:1cqh 2cqw;max-width:100%;min-width:0}
  .vname{font-size:clamp(11px,4.2cqmin,20px);font-weight:600;letter-spacing:.02em;color:var(--secondary-text-color);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
  .demo{flex:none;border:1px solid var(--state-charging,#ff9800);color:var(--state-charging,#ff9800);
    font-size:clamp(11px,4.2cqmin,20px);letter-spacing:.14em;padding:.4cqh 1.6cqw;border-radius:5px}

  /* status word / big voltage / phase — each its OWN grid item (.cluster is display:contents so they
     place directly on the grid: status=row1, volt=row2, phase=row3). Status + voltage are in rows 1-2,
     ABOVE the hero -> plain text, no backing. Only the PHASE (row 3) can sit over the hero, so it's the
     ONLY readout with a legibility backing (the soft --wd-chip wash). */
  .cluster{display:contents}
  .status{grid-area:status;align-self:start;justify-self:end;
    display:inline-flex;align-items:center;gap:1.2cqw;font-weight:600;font-size:clamp(13px,6cqmin,30px);letter-spacing:.02em}
  .status svg{width:1.05em;height:1.05em;display:block}
  /* .volt is a baseline flex row so the small "V" stays attached to the number at every size
     (its font is em-relative -> it tracks the clamped number instead of scaling on its own). */
  .volt{grid-area:volt;align-self:start;justify-self:end;
    display:inline-flex;align-items:baseline;gap:.12em;
    font-size:clamp(20px,20cqmin,52px);font-weight:600;line-height:1;letter-spacing:-.02em}
  .volt small{font-size:.42em;font-weight:500;color:var(--secondary-text-color)}
  /* phase text uses the PRIMARY (high-contrast) colour, not secondary: it's the one readout that sits
     over the hero, and a dim grey barely reads over a bright car even with the scrim. Bright text on
     the card-colour scrim = strong contrast over any hero on either theme. */
  .phase{grid-area:phase;align-self:start;justify-self:end;
    font-size:clamp(12px,5.6cqmin,26px);color:var(--primary-text-color);white-space:nowrap;
    padding:.35cqh 1.8cqw;border-radius:2cqmin;background:var(--wd-chip);
    -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}

  .bar{grid-area:bar;justify-self:stretch;width:100%;height:4cqh;min-height:7px}
  .bar svg{width:100%;height:100%;display:block;overflow:visible}
  .bar .track{fill:var(--divider-color)}
  .bar .red-lo,.bar .red-hi{fill:var(--state-fault,var(--error-color,#d32f2f));opacity:.7}
  .bar .band{fill:var(--state-charged,#43a047);opacity:.9}
  .bar .mark{fill:var(--primary-text-color)}

  .bottom{grid-area:bottom;display:flex;justify-content:space-between;gap:3cqw;font-size:clamp(13px,6cqmin,28px)}
  .bottom .b{display:flex;align-items:center;gap:1.4cqw;color:var(--primary-text-color)}
  .bottom svg{width:.9em;height:.9em;color:var(--secondary-text-color);display:block}

  /* interactive readouts */
  .clickable{cursor:pointer;transition:filter .1s ease}
  .clickable:hover{filter:brightness(1.1)}
  .clickable:focus-visible{outline:2px solid var(--primary-color,#03a9f4);outline-offset:2px}

  /* SHORT cards (little vertical room): a full-width car below the readouts becomes a tiny floating
     band. When the card is short, switch the car into a LEFT COLUMN beside the readouts (there is
     width to spare even when there is no height): name top-left, status/V/phase in the right column,
     car filling the left column. Still its own cell -> never overlaps the readouts. */
  @container (max-height:220px){
    .content{grid-template:
      "name    status" auto
      "hero    volt"   auto
      "hero    phase"  auto
      "hero    ."      minmax(0,1fr)
      "bar     bar"    auto
      "bottom  bottom" auto / 46% 54%}
    .hero{grid-column:1 / 2;grid-row:2 / 5;object-position:left center}
  }

  .overlay{position:absolute;inset:0;z-index:3;display:flex;align-items:center;justify-content:center}
  .obox{display:flex;flex-direction:column;align-items:center;text-align:center;gap:.8cqh;
    padding:1.8cqh 3.4cqw;border-radius:2.5cqmin;max-width:82%;
    background:color-mix(in srgb, var(--ha-card-background,var(--card-background-color,#fff)) 72%, transparent)}
  .overlay .ow{font-size:clamp(20px,11cqmin,52px);font-weight:600;letter-spacing:.14em}
  .overlay .os{font-size:clamp(11px,5.2cqmin,22px);color:var(--secondary-text-color)}
  [hidden]{display:none!important}
`;
