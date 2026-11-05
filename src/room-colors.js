/**
 * Rumskollen: colour rooms (IfcSpace) in 3D by group, by area or by data quality.
 *
 * - Group:   any property, chosen in a dropdown (guessed: area type, room function …)
 * - Area:    fixed classes (10/25/50/100 m²) or quantiles (five equally large classes)
 * - Quality: green = complete, orange = 1 value missing, red = 2+ missing
 *
 * Legend: click = show only that class (click again = show all),
 *         Ctrl/Shift-click = add or remove a class, "Visa alla" resets.
 * Colours go to the viewer through client.colorCodeSpaces (see src/streambim.js).
 *
 * Data: one findObjects call for the space GUIDs, then getObjectInfo per room,
 * two at a time and capped at MAX_ROOMS, so we never loop over the whole model.
 */

import { applyOverride, duplicates, formatName, makeOverride, namesCsv, namingStore, renumber, DEFAULT_TEMPLATE } from "./room-naming.js";

const MAX_ROOMS = 400;
const NO_VALUE = "(saknar värde)";
const FADED = "d4d9df";
const PALETTE = ["3e63dd", "30a46c", "f76b15", "8e4ec6", "e5484d", "12a594", "d6409f", "ffc53d", "0090ff", "a18072", "5b5bd6", "7ce2fe"];
const SEQ = ["c2e5ff", "74b9ff", "0090ff", "0d5bd1", "08307a"];
const QA = {
  ok: { label: "Komplett", color: "30a46c" },
  one: { label: "Saknar 1 värde", color: "f76b15" },
  many: { label: "Saknar 2+ värden", color: "e5484d" },
};
const SKIP_KEYS = /^(@kind|Global Id|GUID|Type Object Global Id|uri|Timestamp|@Document Id|@Building Id|BaseType|groups|Type)$/i;

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n, d = 0) => (n == null || Number.isNaN(n) ? "–" : n.toLocaleString("sv-SE", { minimumFractionDigits: d, maximumFractionDigits: d }));
const isEmpty = (v) => v == null || (typeof v === "string" && v.trim() === "");

function parseNum(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const m = String(v).replace(/\s/g, "").replace(",", ".").match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/** Flatten getObjectInfo (live: { properties }, mock: { props, floor }) to plain key → value. */
function flatten(info) {
  const src = info?.properties ?? info?.props ?? {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === "object") {
      if (v.Name != null) out[k] = v.Name;
    } else out[k] = v;
  }
  return out;
}

function floorOf(info) {
  const storey = info?.properties?.["@Building Storey"];
  return (storey && typeof storey === "object" ? storey.Name : storey) || info?.floor || "";
}

export function createRoomColors({ ready, mount, log = () => {} }) {
  const state = {
    client: null,
    rooms: [],
    keys: [],
    floors: [],
    groupKey: "",
    areaKey: "",
    required: new Set(),
    mode: "group",
    areaBins: "fixed",
    floor: "",
    shown: null, // null = all classes; Set of class keys otherwise
    picked: "",
    loading: false,
    // Namnsättning
    store: null,
    overrides: {},
    template: DEFAULT_TEMPLATE,
    editing: "",
    preview: null, // Map guid → föreslaget nummer
  };

  mount.innerHTML = `
    <div class="rc-head">
      <h2>Färgsätt rum</h2>
      <button type="button" class="rc-load primary">Läs in rum</button>
    </div>
    <p class="rc-status note">Läser in rummen (IfcSpace) och färgar dem i modellen.</p>
    <div class="rc-body" hidden>
      <div class="rc-kpis">
        <div><b class="rc-k-rooms">–</b><span>rum</span></div>
        <div><b class="rc-k-area">–</b><span>m²</span></div>
        <div><b class="rc-k-qa">–</b><span>kompletta</span></div>
      </div>
      <div class="rc-seg" role="tablist">
        <button type="button" data-mode="group" class="on">Grupp</button>
        <button type="button" data-mode="area">Area</button>
        <button type="button" data-mode="qa">Datakvalitet</button>
      </div>
      <div class="rc-opts">
        <label data-for="group">Gruppera på <select class="rc-group"></select></label>
        <label data-for="area">Klasser
          <select class="rc-bins"><option value="fixed">Fasta (10/25/50/100 m²)</option><option value="quantile">Kvantiler (5 lika stora)</option></select>
        </label>
        <label>Areaegenskap <select class="rc-area"></select></label>
        <label>Våning <select class="rc-floor"></select></label>
        <details data-for="qa" class="rc-req-wrap"><summary>Krav på rumsdata</summary><div class="rc-req"></div></details>
      </div>
      <div class="rc-legend"></div>
      <div class="rc-actions">
        <button type="button" class="rc-all">Visa alla</button>
        <button type="button" class="rc-clear">Rensa färger</button>
      </div>
      <p class="note rc-hint">Klick = visa bara den klassen. Ctrl/Shift-klick = lägg till eller ta bort.</p>
      <div class="rc-picked note"></div>
      <ul class="rc-list"></ul>
      <div class="rc-mock" hidden></div>

      <section class="rn">
        <div class="rn-head"><h3>Namnsättning</h3><span class="rn-count note"></span></div>
        <label class="rn-field">Visningsnamn
          <input class="rn-template" spellcheck="false" />
        </label>
        <p class="note rn-help">Fält i klammer: {Name}, {Long Name}, {Våning} eller valfri egenskap, t.ex. {Rumsfunktion}.</p>
        <details class="rn-bulk">
          <summary>Numrera om rum</summary>
          <div class="rn-bulk-form">
            <label class="rn-field">Mönster <input class="rn-pattern" value="{plan}{nr}" spellcheck="false" /></label>
            <label class="rn-field">Siffror i {nr}
              <select class="rn-digits"><option>1</option><option selected>2</option><option>3</option></select>
            </label>
            <label class="rn-field">Startnummer <input class="rn-start" type="number" value="1" min="0" /></label>
            <label class="rn-field">Ordning
              <select class="rn-order"><option value="name">Nuvarande nummer</option><option value="longname">Rumsnamn</option></select>
            </label>
            <div class="rn-bulk-actions">
              <button type="button" class="rn-preview">Förhandsgranska</button>
              <button type="button" class="rn-apply primary" disabled>Tillämpa</button>
              <button type="button" class="rn-cancel-preview" hidden>Avbryt</button>
            </div>
          </div>
          <p class="note">Gäller vald våning, eller alla våningar med numrering per våning. {plan} = våningens ordning nerifrån (1, 2, 3 …), {våning} = våningens namn, {nr} = löpnummer.</p>
        </details>
        <ul class="rn-list"></ul>
        <div class="rn-actions">
          <button type="button" class="rn-export">Exportera namnlista</button>
          <button type="button" class="rn-reset">Återställ alla</button>
        </div>
        <p class="note rn-info">Ändringarna sparas i webbläsaren per projekt och ändrar inte IFC-modellen. Exportera namnlistan (CSV) och för in den i projekteringsverktyget.</p>
      </section>
    </div>`;

  const $ = (sel) => mount.querySelector(sel);

  /* ---------- Loading ---------- */

  async function load() {
    if (state.loading) return;
    state.loading = true;
    $(".rc-load").disabled = true;
    try {
      const client = (state.client = await ready);
      const [floors, guids] = await Promise.all([
        client.getFloors().catch(() => []),
        client.findObjects({ key: "@kind", value: "Space", limit: MAX_ROOMS }),
      ]);
      state.floors = [...floors].sort((a, b) => (a.height ?? a.elevation ?? 0) - (b.height ?? b.elevation ?? 0));
      const rooms = [];
      const queue = [...guids];
      const worker = async () => {
        while (queue.length) {
          const guid = queue.shift();
          try {
            const info = await client.getObjectInfo(guid);
            const props = flatten(info);
            rooms.push({ guid, props, floor: floorOf(info), name: props.Name || info?.name || guid, longName: props["Long Name"] || "" });
          } catch (err) {
            log(`Kunde inte läsa ${guid}: ${err?.message || err}`);
          }
          $(".rc-status").textContent = `Läser rum … ${rooms.length}/${guids.length}`;
        }
      };
      await Promise.all([worker(), worker()]);
      rooms.sort((a, b) => String(a.name).localeCompare(String(b.name), "sv", { numeric: true }));
      state.store = namingStore(await client.getProjectId().catch(() => "okänt"));
      state.overrides = state.store.overrides();
      state.template = state.store.template();
      $(".rn-template").value = state.template;
      for (const r of rooms) applyOverride(r, state.overrides[r.guid]);
      state.rooms = rooms;
      if (!rooms.length) {
        $(".rc-status").textContent = "Hittade inga rum (IfcSpace) i modellen.";
        return;
      }
      guessKeys();
      buildOptions();
      $(".rc-body").hidden = false;
      $(".rc-mock").hidden = client.mode !== "mock";
      $(".rc-load").textContent = "Läs in igen";
      $(".rc-status").textContent = `${rooms.length} rum${guids.length >= MAX_ROOMS ? ` (max ${MAX_ROOMS})` : ""} · ${state.floors.length} våningar`;
      render();
      apply();
    } catch (err) {
      $(".rc-status").textContent = `Fel: ${err?.message || err}`;
      log(`Rumsinläsning misslyckades: ${err?.message || err}`);
    } finally {
      state.loading = false;
      $(".rc-load").disabled = false;
    }
  }

  function guessKeys() {
    const all = new Set();
    for (const r of state.rooms) Object.keys(r.props).forEach((k) => all.add(k));
    state.keys = [...all].filter((k) => !SKIP_KEYS.test(k)).sort((a, b) => a.localeCompare(b, "sv"));
    const values = (k) => state.rooms.map((r) => r.props[k]).filter((v) => !isEmpty(v));
    const numeric = state.keys.filter((k) => {
      const v = values(k);
      return v.length && v.filter((x) => parseNum(x) != null).length / v.length > 0.8 && !/name|nummer|number/i.test(k);
    });
    const grouping = state.keys.filter((k) => {
      const n = new Set(values(k)).size;
      return n >= 2 && n <= 30 && !numeric.includes(k) && !/^(Name|Long Name)$/i.test(k);
    });
    const find = (list, re) => list.find((k) => re.test(k));
    state.areaKey = find(numeric, /net.*area|nta|bra|loa|boa|netto/i) || find(numeric, /area|yta|bta/i) || numeric[0] || "";
    state.groupKey = find(grouping, /areatyp|area ?type|rumstyp|rumsfunktion|funktion|function|department|avdelning|occupancy|kategori/i) || grouping[0] || "Long Name";
    state.required = new Set(["Name", "Long Name", state.areaKey, state.groupKey].filter((k) => k && all.has(k)));
  }

  function buildOptions() {
    const opts = (sel) => state.keys.map((k) => `<option ${k === sel ? "selected" : ""}>${esc(k)}</option>`).join("");
    $(".rc-group").innerHTML = opts(state.groupKey);
    $(".rc-area").innerHTML = `<option value="">(ingen)</option>` + opts(state.areaKey);
    const used = new Set(state.rooms.map((r) => r.floor).filter(Boolean));
    const names = state.floors.map((f) => f.name).filter((n) => used.has(n));
    for (const n of used) if (!names.includes(n)) names.push(n);
    $(".rc-floor").innerHTML = `<option value="">Alla våningar</option>` + names.map((n) => `<option ${n === state.floor ? "selected" : ""}>${esc(n)}</option>`).join("");
    $(".rc-req").innerHTML = state.keys
      .map((k) => `<label><input type="checkbox" value="${esc(k)}" ${state.required.has(k) ? "checked" : ""}> ${esc(k)}</label>`)
      .join("");
  }

  /* ---------- Classification ---------- */

  const scoped = () => state.rooms.filter((r) => !state.floor || r.floor === state.floor);
  const areaOf = (r) => (state.areaKey ? parseNum(r.props[state.areaKey]) : null);
  const missingOf = (r) => [...state.required].filter((k) => isEmpty(r.props[k]));

  function classes() {
    const rooms = scoped();
    if (state.mode === "group") {
      const tot = new Map();
      for (const r of rooms) {
        const g = isEmpty(r.props[state.groupKey]) ? NO_VALUE : String(r.props[state.groupKey]);
        tot.set(g, (tot.get(g) || 0) + (areaOf(r) || 0) + 1e-6);
      }
      const order = [...tot.keys()].filter((g) => g !== NO_VALUE).sort((a, b) => tot.get(b) - tot.get(a));
      const color = (g) => (g === NO_VALUE ? "8b8d98" : PALETTE[order.indexOf(g) % PALETTE.length]);
      const keyOf = (r) => (isEmpty(r.props[state.groupKey]) ? NO_VALUE : String(r.props[state.groupKey]));
      return { keyOf, order: [...order, NO_VALUE], label: (k) => k, color };
    }
    if (state.mode === "area") {
      let edges = [10, 25, 50, 100];
      if (state.areaBins === "quantile") {
        const v = rooms.map(areaOf).filter((x) => x != null).sort((a, b) => a - b);
        edges = v.length ? [0.2, 0.4, 0.6, 0.8].map((q) => v[Math.min(v.length - 1, Math.floor(q * v.length))]) : edges;
        edges = edges.filter((e, i) => i === 0 || e > edges[i - 1]);
      }
      const keyOf = (r) => {
        const a = areaOf(r);
        if (a == null) return "none";
        const i = edges.findIndex((e) => a < e);
        return `b${i === -1 ? edges.length : i}`;
      };
      const label = (k) => {
        if (k === "none") return "Ingen area";
        const i = Number(k.slice(1));
        if (i === 0) return `< ${fmt(edges[0], 1)} m²`;
        if (i === edges.length) return `≥ ${fmt(edges[i - 1], 1)} m²`;
        return `${fmt(edges[i - 1], 1)}–${fmt(edges[i], 1)} m²`;
      };
      const step = (SEQ.length - 1) / Math.max(1, edges.length);
      const color = (k) => (k === "none" ? "8b8d98" : SEQ[Math.round(Number(k.slice(1)) * step)]);
      return { keyOf, order: [...edges.map((_, i) => `b${i}`), `b${edges.length}`, "none"], label, color };
    }
    const keyOf = (r) => {
      const n = missingOf(r).length;
      return n === 0 ? "ok" : n === 1 ? "one" : "many";
    };
    return { keyOf, order: ["ok", "one", "many"], label: (k) => QA[k].label, color: (k) => QA[k].color };
  }

  function legend() {
    const c = classes();
    const rows = new Map();
    for (const r of scoped()) {
      const k = c.keyOf(r);
      if (!rows.has(k)) rows.set(k, { key: k, label: c.label(k), color: c.color(k), count: 0, area: 0, rooms: [] });
      const row = rows.get(k);
      row.count++;
      row.area += areaOf(r) || 0;
      row.rooms.push(r);
    }
    return { c, items: c.order.filter((k) => rows.has(k)).map((k) => rows.get(k)) };
  }

  const isShown = (k) => !state.shown || state.shown.has(k);

  /* ---------- Rendering ---------- */

  function render() {
    const rooms = scoped();
    const total = rooms.reduce((s, r) => s + (areaOf(r) || 0), 0);
    const ok = rooms.filter((r) => !missingOf(r).length).length;
    $(".rc-k-rooms").textContent = fmt(rooms.length);
    $(".rc-k-area").textContent = fmt(total, 1);
    $(".rc-k-qa").textContent = rooms.length ? `${Math.round((100 * ok) / rooms.length)} %` : "–";
    mount.querySelectorAll(".rc-seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === state.mode));
    mount.querySelectorAll("[data-for]").forEach((el) => (el.hidden = el.dataset.for !== state.mode));

    const { c, items } = legend();
    const maxArea = Math.max(1, ...items.map((i) => i.area));
    let html = items
      .map(
        (i) => `<button type="button" class="rc-item ${isShown(i.key) ? "" : "off"}" data-key="${esc(i.key)}">
          <span class="rc-sw" style="background:#${i.color}"></span>
          <span class="rc-lbl">${esc(i.label)}<i style="width:${Math.round((100 * i.area) / maxArea)}%;background:#${i.color}"></i></span>
          <span class="rc-num">${i.count} st</span><span class="rc-num">${fmt(i.area, 1)} m²</span>
        </button>`,
      )
      .join("");
    if (state.mode === "qa") {
      const cnt = {};
      for (const r of rooms) for (const k of missingOf(r)) cnt[k] = (cnt[k] || 0) + 1;
      const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (top.length) html += `<p class="note rc-missing">Saknas oftast: ${top.map(([k, n]) => `<span class="rc-pill">${esc(k)} · ${n}</span>`).join(" ")}</p>`;
    }
    $(".rc-legend").innerHTML = html || `<p class="note">Inga rum på vald våning.</p>`;

    // Rooms in the visible classes; clicking one flies to it
    const visible = items.filter((i) => isShown(i.key)).flatMap((i) => i.rooms.map((r) => ({ r, color: i.color })));
    $(".rc-list").innerHTML = state.shown
      ? visible
          .slice(0, 60)
          .map(({ r, color }) => {
            const miss = missingOf(r);
            return `<li data-guid="${esc(r.guid)}" class="${r.guid === state.picked ? "on" : ""}">
              <span class="rc-dot" style="background:#${color}"></span>
              <span>${esc(label(r))}${miss.length ? ` <small class="rc-warn" title="${esc(miss.join(", "))}">⚠ ${miss.length}</small>` : ""}</span>
              <b>${fmt(areaOf(r), 1)}</b></li>`;
          })
          .join("") + (visible.length > 60 ? `<li class="note">… och ${visible.length - 60} till</li>` : "")
      : "";

    const picked = state.rooms.find((r) => r.guid === state.picked);
    $(".rc-picked").innerHTML = picked
      ? `Valt rum <b>${esc(label(picked))}</b> hör till <b>${esc(c.label(c.keyOf(picked)))}</b>${missingOf(picked).length ? ` · saknar ${esc(missingOf(picked).join(", "))}` : ""} <button type="button" class="rn-edit" data-guid="${esc(picked.guid)}">Byt namn</button>`
      : "";
    mount.querySelectorAll(".rc-item").forEach((el) => el.classList.toggle("hit", !!picked && el.dataset.key === c.keyOf(picked)));

    renderMock();
    renderNaming();
  }

  /** Colour map for the viewer: visible classes get their colour, hidden ones are left out (faded). */
  function colorMap() {
    const { c } = legend();
    const map = {};
    for (const r of scoped()) {
      const k = c.keyOf(r);
      if (isShown(k)) map[r.guid] = c.color(k);
    }
    return map;
  }

  // In mock mode there is no 3D view, so draw the rooms as tiles per floor.
  function renderMock() {
    if (state.client?.mode !== "mock") return;
    const map = colorMap();
    const byFloor = new Map();
    for (const r of state.rooms) {
      if (!byFloor.has(r.floor)) byFloor.set(r.floor, []);
      byFloor.get(r.floor).push(r);
    }
    $(".rc-mock").innerHTML =
      `<p class="note">Mock-modell (så här färgas rummen i 3D)</p>` +
      [...byFloor]
        .map(
          ([floor, rooms]) => `<div class="rc-mock-floor ${state.floor && state.floor !== floor ? "dim" : ""}"><span>${esc(floor)}</span><div>${rooms
            .map((r) => {
              const col = map[r.guid];
              const w = Math.max(28, Math.min(90, Math.sqrt(areaOf(r) || 9) * 9));
              return `<em data-guid="${esc(r.guid)}" title="${esc(label(r))}" class="${r.guid === state.picked ? "on" : ""}" style="width:${w}px;background:${col ? `#${col}` : `#${FADED}`};opacity:${col ? 1 : 0.4}">${esc(r.name)}</em>`;
            })
            .join("")}</div></div>`,
        )
        .join("");
  }

  /* ---------- Viewer ---------- */

  let timer;
  function apply() {
    clearTimeout(timer);
    // colorCodeSpaces re-runs a search each call; ~3 updates/s is what the viewer draws reliably.
    timer = setTimeout(async () => {
      try {
        await state.client.colorCodeSpaces(colorMap());
      } catch (err) {
        log(`Färgsättning misslyckades: ${err?.message || err}`);
      }
    }, 300);
  }

  async function clearColors() {
    clearTimeout(timer);
    state.shown = null;
    try {
      await state.client?.colorCodeSpaces({});
    } catch (err) {
      log(`Kunde inte rensa färger: ${err?.message || err}`);
    }
    render();
    if (state.client?.mode === "mock") $(".rc-mock").querySelectorAll("em").forEach((e) => (e.style.background = `#${FADED}`));
  }

  async function goRoom(guid) {
    state.picked = guid;
    render();
    try {
      await state.client.gotoObject(guid);
      await state.client.highlightObject(guid);
    } catch (err) {
      log(`Kunde inte gå till rummet: ${err?.message || err}`);
    }
  }


  /* ---------- Namnsättning ---------- */

  const label = (r) => formatName(state.template, r);

  function renderNaming() {
    const rooms = scoped();
    const dupes = duplicates(state.rooms);
    const changed = state.rooms.filter((r) => r.changed).length;
    $(".rn-count").textContent = `${changed} ändrade${dupes.size ? ` · ${dupes.size} dubbletter` : ""}`;
    $(".rn-apply").disabled = !state.preview;
    $(".rn-cancel-preview").hidden = !state.preview;
    const sorted = [...rooms].sort((a, b) => String(a.name).localeCompare(String(b.name), "sv", { numeric: true }));
    $(".rn-list").innerHTML =
      sorted
        .slice(0, 200)
        .map((r) => {
          if (r.guid === state.editing) {
            return `<li class="rn-editing" data-guid="${esc(r.guid)}">
              <label class="rn-field">Rumsnummer <input class="rn-in-name" value="${esc(r.name === r.guid ? "" : r.name)}" /></label>
              <label class="rn-field">Rumsnamn <input class="rn-in-long" value="${esc(r.longName)}" /></label>
              <p class="note">Original: ${esc(r.orig?.Name || "–")} ${esc(r.orig?.["Long Name"] || "")}</p>
              <div class="rn-row-actions">
                <button type="button" class="rn-save primary">Spara</button>
                <button type="button" class="rn-revert">Originalvärde</button>
                <button type="button" class="rn-cancel">Avbryt</button>
              </div>
            </li>`;
          }
          const next = state.preview?.get(r.guid);
          const dup = dupes.has(String(r.name));
          return `<li data-guid="${esc(r.guid)}" class="${r.guid === state.picked ? "on" : ""}">
            <span class="rn-text"><b>${esc(label(r))}</b>
              <small>${esc(r.floor)}${r.changed ? ' · <span class="rn-badge">ändrat</span>' : ""}${dup ? ' · <span class="rn-dup">dubblett</span>' : ""}</small>
              ${next != null && next !== r.name ? `<small class="rn-next">${esc(r.name)} → <b>${esc(next)}</b></small>` : ""}
            </span>
            <button type="button" class="rn-edit" data-guid="${esc(r.guid)}">Ändra</button>
          </li>`;
        })
        .join("") + (sorted.length > 200 ? `<li class="note">… och ${sorted.length - 200} till. Välj en våning för att se alla.</li>` : "");
    if (state.editing) mount.querySelector(".rn-in-name")?.focus();
  }

  function saveOverrides() {
    state.store?.saveOverrides(state.overrides);
  }

  function setOverride(room, values) {
    const o = makeOverride(room, values);
    if (Object.keys(o).length) state.overrides[room.guid] = o;
    else delete state.overrides[room.guid];
    applyOverride(room, state.overrides[room.guid]);
  }

  function afterNamingChange() {
    saveOverrides();
    state.rooms.sort((a, b) => String(a.name).localeCompare(String(b.name), "sv", { numeric: true }));
    render();
    apply();
  }

  function startEdit(guid) {
    state.editing = guid;
    render();
    mount.querySelector(".rn-editing")?.scrollIntoView({ block: "nearest" });
  }

  function download(name, text) {
    const blob = new Blob(["﻿", text], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  $(".rn-template").addEventListener("input", (e) => {
    state.template = e.target.value || DEFAULT_TEMPLATE;
    state.store?.saveTemplate(state.template);
    render();
  });

  mount.addEventListener("click", (e) => {
    const edit = e.target.closest(".rn-edit");
    if (edit) {
      e.stopPropagation();
      startEdit(edit.dataset.guid);
      return;
    }
    const row = e.target.closest(".rn-list li[data-guid]");
    if (!row) return;
    const room = state.rooms.find((r) => r.guid === row.dataset.guid);
    if (!room) return;
    if (e.target.closest(".rn-save")) {
      setOverride(room, { name: row.querySelector(".rn-in-name").value.trim(), longName: row.querySelector(".rn-in-long").value.trim() });
      state.editing = "";
      log(`Namn ändrat: ${label(room)}`);
      afterNamingChange();
    } else if (e.target.closest(".rn-revert")) {
      delete state.overrides[room.guid];
      applyOverride(room, null);
      state.editing = "";
      afterNamingChange();
    } else if (e.target.closest(".rn-cancel")) {
      state.editing = "";
      render();
    } else if (!row.classList.contains("rn-editing")) {
      goRoom(room.guid);
    }
  });

  mount.addEventListener("keydown", (e) => {
    if (!e.target.closest(".rn-editing")) return;
    if (e.key === "Enter") e.target.closest(".rn-editing").querySelector(".rn-save").click();
    if (e.key === "Escape") e.target.closest(".rn-editing").querySelector(".rn-cancel").click();
  });

  $(".rn-preview").addEventListener("click", () => {
    state.preview = renumber(scoped(), {
      pattern: $(".rn-pattern").value || "{plan}{nr}",
      digits: Number($(".rn-digits").value),
      start: Number($(".rn-start").value || 1),
      order: $(".rn-order").value,
      floorOrder: state.floors.map((f) => f.name),
    });
    render();
  });

  $(".rn-cancel-preview").addEventListener("click", () => {
    state.preview = null;
    render();
  });

  $(".rn-apply").addEventListener("click", () => {
    if (!state.preview) return;
    let n = 0;
    for (const [guid, name] of state.preview) {
      const room = state.rooms.find((r) => r.guid === guid);
      if (!room || room.name === name) continue;
      setOverride(room, { name, longName: room.longName });
      n += 1;
    }
    state.preview = null;
    log(`${n} rum har fått nya nummer.`);
    afterNamingChange();
  });

  // Två klick i stället för confirm(), som kan vara blockerat i StreamBIM:s iframe.
  let resetTimer;
  $(".rn-reset").addEventListener("click", (e) => {
    if (!Object.keys(state.overrides).length) return;
    const button = e.currentTarget;
    if (!button.dataset.armed) {
      button.dataset.armed = "1";
      button.textContent = "Klicka igen för att återställa";
      resetTimer = setTimeout(() => {
        delete button.dataset.armed;
        button.textContent = "Återställ alla";
      }, 4000);
      return;
    }
    clearTimeout(resetTimer);
    delete button.dataset.armed;
    button.textContent = "Återställ alla";
    state.overrides = {};
    for (const r of state.rooms) applyOverride(r, null);
    state.preview = null;
    afterNamingChange();
  });

  $(".rn-export").addEventListener("click", () => download("rumsnamn.csv", namesCsv(state.rooms)));

  /* ---------- Events ---------- */

  $(".rc-load").addEventListener("click", load);
  mount.addEventListener("click", (e) => {
    const seg = e.target.closest(".rc-seg button");
    if (seg) {
      state.mode = seg.dataset.mode;
      state.shown = null;
      render();
      apply();
      return;
    }
    const item = e.target.closest(".rc-item");
    if (item) {
      const k = item.dataset.key;
      const all = legend().items.map((i) => i.key);
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        const s = new Set(state.shown ?? all);
        s.has(k) ? s.delete(k) : s.add(k);
        state.shown = s.size === all.length ? null : s;
      } else {
        const onlyThis = state.shown && state.shown.size === 1 && state.shown.has(k);
        state.shown = onlyThis ? null : new Set([k]);
      }
      render();
      apply();
      return;
    }
    const li = e.target.closest(".rc-list li[data-guid], .rc-mock em[data-guid]");
    if (li) goRoom(li.dataset.guid);
  });
  $(".rc-all").addEventListener("click", () => {
    state.shown = null;
    render();
    apply();
  });
  $(".rc-clear").addEventListener("click", clearColors);
  $(".rc-group").addEventListener("change", (e) => {
    state.groupKey = e.target.value;
    state.shown = null;
    render();
    apply();
  });
  $(".rc-area").addEventListener("change", (e) => {
    state.areaKey = e.target.value;
    render();
    apply();
  });
  $(".rc-bins").addEventListener("change", (e) => {
    state.areaBins = e.target.value;
    state.shown = null;
    render();
    apply();
  });
  $(".rc-floor").addEventListener("change", async (e) => {
    state.floor = e.target.value;
    state.shown = null;
    render();
    apply();
    const f = state.floors.find((x) => x.name === state.floor);
    if (f) state.client.gotoFloor(f.id).catch(() => {});
  });
  $(".rc-req").addEventListener("change", (e) => {
    const k = e.target.value;
    e.target.checked ? state.required.add(k) : state.required.delete(k);
    render();
    apply();
  });

  return {
    /** Call from onPickedObject: marks the room's class in the legend. */
    picked(guid) {
      if (!state.rooms.some((r) => r.guid === guid)) return;
      state.picked = guid;
      render();
    },
    /** Call from onFloorChanged: follow the viewer's floor. */
    floorChanged(floorId) {
      const f = state.floors.find((x) => String(x.id) === String(floorId));
      // Only follow the viewer when a single floor is already chosen in the widget.
      if (!f || !state.rooms.length || !state.floor || f.name === state.floor) return;
      state.floor = f.name;
      state.shown = null;
      buildOptions();
      render();
      apply();
    },
  };
}
