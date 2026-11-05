/**
 * Ölburks-widget: ställ ut burkar från Systembolagets katalog i StreamBIM,
 * med artikelnummer och GTIN som egenskaper på objektet.
 * Kopplingen ligger i src/streambim.js, placeringen i src/beer.js.
 */

import { catalog, canSize, isValidGtin } from "./catalog.js";
import { objects } from "./mock-data.js";
import { canName, describeError, placeCan, registry, removeCan, toCsv } from "./beer.js";
import { connectWidget } from "./streambim.js";
import "./style.css";

const $ = (selector) => document.querySelector(selector);

const statusEl = $("#status");
const searchEl = $("#search");
const catalogEl = $("#catalog");
const selectedEl = $("#selected");
const armEl = $("#arm");
const placedEl = $("#placed");
const placedEmptyEl = $("#placed-empty");
const countEl = $("#count");
const exportEl = $("#export");
const logEl = $("#log");
const simulatorEl = $("#simulator");
const chipsEl = $("#object-chips");

const modeLabel = { mock: "Lokalt", live: "Live", error: "Ingen kontakt" };

const state = {
  client: null,
  selected: null,
  armed: false,
  busy: false,
  cans: null,
  gtinOverrides: readOverrides(),
};

/* ---------- Logg ---------- */

function log(message, kind = "info") {
  const item = document.createElement("li");
  item.dataset.kind = kind;
  const time = new Date().toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  item.textContent = `${time} ${message}`;
  logEl.prepend(item);
  while (logEl.children.length > 30) logEl.lastChild.remove();
}

/* ---------- GTIN ---------- */

function readOverrides() {
  try {
    return JSON.parse(localStorage.getItem("beer-gtin-overrides") ?? "{}");
  } catch {
    return {};
  }
}

function saveOverride(artikelnummer, gtin) {
  state.gtinOverrides[artikelnummer] = gtin;
  try {
    localStorage.setItem("beer-gtin-overrides", JSON.stringify(state.gtinOverrides));
  } catch {
    /* Bara för sessionen om lagring är blockerad. */
  }
}

function gtinFor(beer) {
  return beer.gtin ?? state.gtinOverrides[beer.artikelnummer] ?? null;
}

function gtinStatus(beer) {
  const gtin = gtinFor(beer);
  if (!gtin) return { text: "GTIN saknas", kind: "missing" };
  if (!isValidGtin(gtin)) return { text: "GTIN ogiltigt", kind: "bad" };
  return { text: beer.gtin ? "GTIN" : "GTIN (eget)", kind: "ok" };
}

/* ---------- Katalog ---------- */

function cl(beer) {
  return `${beer.volymMl / 10} cl`;
}

function matches(beer, query) {
  if (!query) return true;
  const haystack = [beer.namn, beer.producent, beer.stil, beer.artikelnummer, gtinFor(beer) ?? ""].join(" ").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

function renderCatalog() {
  const query = searchEl.value.trim();
  catalogEl.replaceChildren();
  const hits = catalog.filter((beer) => matches(beer, query));
  if (!hits.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "Inga träffar.";
    catalogEl.append(empty);
    return;
  }
  for (const beer of hits) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "beer";
    if (state.selected === beer) button.classList.add("on");

    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = `#${beer.farg}`;

    const text = document.createElement("span");
    text.className = "beer-text";
    const title = document.createElement("b");
    title.textContent = beer.namn;
    const meta = document.createElement("small");
    meta.textContent = `Nr ${beer.artikelnummer} · ${cl(beer)} · ${String(beer.alkohol).replace(".", ",")} %`;
    text.append(title, meta);

    const badge = document.createElement("span");
    const status = gtinStatus(beer);
    badge.className = `badge ${status.kind}`;
    badge.textContent = status.text;

    button.append(swatch, text, badge);
    button.addEventListener("click", () => select(beer));
    item.append(button);
    catalogEl.append(item);
  }
}

function select(beer) {
  state.selected = beer;
  selectedEl.hidden = false;
  $("#sel-swatch").style.background = `#${beer.farg}`;
  $("#sel-name").textContent = beer.namn;
  $("#sel-meta").textContent = `${beer.producent} · ${beer.stil} · ${String(beer.alkohol).replace(".", ",")} % · ${String(beer.prisKr.toFixed(2)).replace(".", ",")} kr`;
  $("#sel-artnr").textContent = beer.artikelnummer;
  const gtin = gtinFor(beer);
  const gtinEl = $("#sel-gtin");
  gtinEl.textContent = gtin ?? "saknas";
  gtinEl.className = gtin && isValidGtin(gtin) ? "" : "warn";
  $("#gtin-edit").hidden = Boolean(beer.gtin);
  $("#gtin-input").value = beer.gtin ? "" : gtin ?? "";
  const size = canSize(beer.volymMl);
  $("#sel-size").textContent = `${cl(beer)}, ⌀ ${size.diameter * 1000} × ${size.height * 1000} mm`;
  $("#sel-link").href = beer.url;
  renderCatalog();
  updateArm();
}

$("#gtin-save").addEventListener("click", () => {
  const beer = state.selected;
  if (!beer) return;
  const value = $("#gtin-input").value.replace(/\s/g, "");
  if (!isValidGtin(value)) {
    log(`${value || "Tomt"} är inget giltigt GTIN (fel längd eller kontrollsiffra).`, "error");
    return;
  }
  saveOverride(beer.artikelnummer, value);
  log(`GTIN ${value} sparat för Nr ${beer.artikelnummer}.`, "ok");
  select(beer);
});

searchEl.addEventListener("input", renderCatalog);

/* ---------- Utställning ---------- */

function mode() {
  return document.querySelector('input[name="mode"]:checked')?.value ?? "zone";
}

function updateArm() {
  armEl.disabled = !state.selected || !state.client || state.client.mode === "error";
  armEl.classList.toggle("armed", state.armed);
  armEl.textContent = state.busy ? "Ställer ut…" : state.armed ? "Klicka i modellen · Avbryt" : "Ställ ut vid klick";
}

armEl.addEventListener("click", () => {
  state.armed = !state.armed;
  updateArm();
  if (state.armed) log(`Klicka på en yta i modellen för att ställa ut ${state.selected.namn}.`);
});

async function onPick(result) {
  const guid = result?.guid;
  if (!state.armed || !state.selected) {
    if (guid) log(`Klick på ${result.name ?? guid}. Välj en öl och tryck "Ställ ut vid klick".`);
    return;
  }
  if (state.busy) return;
  const beer = state.selected;
  const gtin = gtinFor(beer);
  if (gtin && !isValidGtin(gtin)) {
    log(`GTIN ${gtin} har fel kontrollsiffra. Rätta det först.`, "error");
    return;
  }
  state.busy = true;
  updateArm();
  try {
    const placed = await placeCan(state.client, { beer, gtin, point: result.point, pickedGuid: guid, mode: mode() });
    const can = {
      id: placed.id,
      mode: placed.mode,
      center: placed.center,
      artikelnummer: beer.artikelnummer,
      gtin,
      namn: beer.namn,
      volymMl: beer.volymMl,
      prisKr: beer.prisKr,
      farg: beer.farg,
      createdAt: new Date().toISOString(),
    };
    state.cans.add(can);
    renderPlaced();
    log(`${canName(beer)} utställd (${placed.mode === "zone" ? "zon" : "punkt"}, id ${placed.id}).`, "ok");
    if (!gtin) log(`Obs: Nr ${beer.artikelnummer} saknar GTIN. Fältet sparades tomt.`, "warn");
  } catch (error) {
    const text = describeError(error);
    if (/DataCloneError/i.test(text)) {
      log("StreamBIM svarade med DataCloneError. Skrivningen kan ändå ha gått igenom. Ladda om vyn och kontrollera.", "warn");
    } else {
      log(`Kunde inte ställa ut burken: ${text}`, "error");
    }
  } finally {
    state.busy = false;
    updateArm();
  }
}

function renderPlaced() {
  const cans = state.cans?.list() ?? [];
  countEl.textContent = String(cans.length);
  placedEmptyEl.hidden = cans.length > 0;
  exportEl.disabled = cans.length === 0;
  placedEl.replaceChildren();
  for (const can of cans) {
    const item = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = `#${can.farg}`;
    const text = document.createElement("span");
    text.className = "beer-text";
    const title = document.createElement("b");
    title.textContent = `${can.namn} ${can.volymMl / 10} cl`;
    const meta = document.createElement("small");
    meta.textContent = `Nr ${can.artikelnummer} · GTIN ${can.gtin ?? "saknas"} · ${can.mode === "zone" ? "zon" : "punkt"}`;
    text.append(title, meta);

    const actions = document.createElement("span");
    actions.className = "actions";
    const show = document.createElement("button");
    show.type = "button";
    show.textContent = "Visa";
    show.addEventListener("click", () => {
      state.client.gotoObject(can.id).catch((error) => log(`Kunde inte visa ${can.id}: ${describeError(error)}`, "warn"));
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = can.mode === "zone" ? "Ta bort" : "Glöm";
    remove.title = can.mode === "zone" ? "Raderar zonen i StreamBIM" : "Punkter kan inte raderas i StreamBIM. Tar bara bort raden här.";
    remove.addEventListener("click", async () => {
      try {
        const deleted = await removeCan(state.client, can);
        state.cans.remove(can.id);
        renderPlaced();
        log(deleted ? `Burken ${can.id} är borttagen.` : `Punkten ${can.id} finns kvar i StreamBIM men är borttagen ur listan.`, deleted ? "ok" : "warn");
      } catch (error) {
        log(`Kunde inte ta bort ${can.id}: ${describeError(error)}`, "error");
      }
    });
    actions.append(show, remove);
    item.append(swatch, text, actions);
    placedEl.append(item);
  }
}

exportEl.addEventListener("click", () => {
  const csv = toCsv(state.cans.list());
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "olburkar.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  log("CSV med artikelnummer, GTIN och antal exporterad.", "ok");
});

/* ---------- Mock-simulator ---------- */

function renderChips(client) {
  chipsEl.replaceChildren();
  for (const object of objects) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = object.name;
    button.addEventListener("click", () => {
      for (const chip of chipsEl.querySelectorAll("button")) chip.classList.remove("on");
      button.classList.add("on");
      client.simulate?.pick(object.guid);
    });
    chipsEl.append(button);
  }
}

/* ---------- Start ---------- */

function loadWidgetApi() {
  if (window.StreamBIM?.connectToParent) return Promise.resolve();
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = `${import.meta.env.BASE_URL}streambim-widget-api.min.js`;
    script.onload = () => resolve();
    script.onerror = () => resolve();
    document.head.append(script);
  });
}

renderCatalog();
renderPlaced();

const ready = loadWidgetApi().then(() =>
  connectWidget({
    onPickedObject(result) {
      ready.then(() => onPick(result));
    },
  }),
);

ready
  .then(async (client) => {
    state.client = client;
    statusEl.dataset.mode = client.mode;
    statusEl.textContent = modeLabel[client.mode] || client.mode;
    simulatorEl.hidden = client.mode !== "mock";
    if (client.mode === "mock") renderChips(client);
    if (client.mode === "error") {
      log(client.reason, "error");
    } else {
      const projectId = await client.getProjectId().catch(() => "okänt");
      state.cans = registry(projectId);
      renderPlaced();
      log(`Ansluten (${modeLabel[client.mode]}), projekt ${projectId}. ${catalog.length} öl i katalogen.`, "ok");
    }
    updateArm();
  })
  .catch((error) => {
    statusEl.dataset.mode = "error";
    statusEl.textContent = modeLabel.error;
    simulatorEl.hidden = true;
    log(describeError(error), "error");
  });
