/**
 * Ölburks-widget: ställ ut burkar från Systembolagets katalog i StreamBIM,
 * med artikelnummer och GTIN som egenskaper på objektet.
 * Kopplingen ligger i src/streambim.js, placeringen i src/beer.js.
 */

import { catalog, isValidGtin, refLabel, sizeFor, sizeLabel, strengthLabel } from "./catalog.js";
import { objects } from "./mock-data.js";
import { canName, colorMap, describeError, placeCan, registry, removeCan, toCsv } from "./beer.js";
import { connectWidget } from "./streambim.js";
import { detectBarcodes, matchBeers, prepareImage, recognizeText } from "./ocr.js";
import { createRoomColors } from "./room-colors.js";
import { createRiskCheck } from "./risk-check.js";
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
const colorizeEl = $("#colorize");
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
  colorized: false,
  kind: "alla",
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

function saveOverride(productId, gtin) {
  state.gtinOverrides[productId] = gtin;
  try {
    localStorage.setItem("beer-gtin-overrides", JSON.stringify(state.gtinOverrides));
  } catch {
    /* Bara för sessionen om lagring är blockerad. */
  }
}

function gtinFor(beer) {
  return beer.gtin ?? state.gtinOverrides[beer.id] ?? null;
}

function gtinStatus(beer) {
  const gtin = gtinFor(beer);
  if (!gtin) return { text: "GTIN saknas", kind: "missing" };
  if (!isValidGtin(gtin)) return { text: "GTIN ogiltigt", kind: "bad" };
  return { text: beer.gtin ? "GTIN" : "GTIN (eget)", kind: "ok" };
}

/* ---------- Katalog ---------- */

function cl(beer) {
  return sizeLabel(beer);
}

function matches(beer, query) {
  if (!query) return true;
  const haystack = [beer.namn, beer.producent, beer.stil, beer.kategori, beer.artikelnummer ?? "", gtinFor(beer) ?? ""].join(" ").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

function renderCatalog() {
  const query = searchEl.value.trim();
  catalogEl.replaceChildren();
  const hits = catalog.filter((beer) => (state.kind === "alla" || beer.kategori === state.kind) && matches(beer, query));
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
    meta.textContent = `${refLabel(beer)} · ${cl(beer)} · ${strengthLabel(beer)}`;
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
  $("#sel-meta").textContent = [beer.producent, beer.stil, strengthLabel(beer), beer.prisKr != null ? `${beer.prisKr.toFixed(2).replace(".", ",")} kr` : null, beer.portioner ? `${beer.portioner} portioner` : null].filter(Boolean).join(" · ");
  $("#sel-artnr").textContent = beer.artikelnummer ?? "– (säljs ej på Systembolaget)";
  const gtin = gtinFor(beer);
  const gtinEl = $("#sel-gtin");
  gtinEl.textContent = gtin ?? "saknas";
  gtinEl.className = gtin && isValidGtin(gtin) ? "" : "warn";
  $("#gtin-edit").hidden = Boolean(beer.gtin);
  $("#gtin-input").value = beer.gtin ? "" : gtin ?? "";
  const size = sizeFor(beer);
  $("#sel-size-label").textContent = beer.kategori === "snus" ? "Dosa" : "Burk";
  $("#sel-size").textContent = `${cl(beer)}, ⌀ ${size.diameter * 1000} × ${size.height * 1000} mm`;
  $("#sel-link-label").textContent = beer.kategori === "snus" ? "Källa GTIN" : "Produktsida";
  $("#sel-link").href = beer.url;
  $("#sel-link").textContent = new URL(beer.url).hostname.replace(/^www\./, "");
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
  saveOverride(beer.id, value);
  log(`GTIN ${value} sparat för ${beer.namn} (${refLabel(beer)}).`, "ok");
  select(beer);
});

searchEl.addEventListener("input", renderCatalog);

$("#kind-filter").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-kind]");
  if (!button) return;
  state.kind = button.dataset.kind;
  for (const item of $("#kind-filter").querySelectorAll("button")) item.classList.toggle("on", item === button);
  renderCatalog();
});

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
  if (activeTab !== "beer") return;
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
      productId: beer.id,
      kategori: beer.kategori,
      artikelnummer: beer.artikelnummer,
      storlek: cl(beer),
      gtin,
      namn: beer.namn,
      volymMl: beer.volymMl,
      prisKr: beer.prisKr,
      farg: beer.farg,
      createdAt: new Date().toISOString(),
    };
    state.cans.add(can);
    renderPlaced();
    if (state.colorized) applyColors();
    log(`${canName(beer)} utställd (${placed.mode === "zone" ? "zon" : "punkt"}, id ${placed.id}).`, "ok");
    if (!gtin) log(`Obs: ${refLabel(beer)} saknar GTIN. Fältet sparades tomt.`, "warn");
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
  colorizeEl.disabled = !cans.some((can) => can.mode === "zone") && !state.colorized;
  colorizeEl.textContent = state.colorized ? "Släck färger" : "Visa i produktens färg";
  colorizeEl.classList.toggle("on", state.colorized);
  placedEl.replaceChildren();
  for (const can of cans) {
    const item = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = `#${can.farg}`;
    const text = document.createElement("span");
    text.className = "beer-text";
    const title = document.createElement("b");
    title.textContent = `${can.namn} ${can.storlek ?? `${can.volymMl / 10} cl`}`;
    const meta = document.createElement("small");
    meta.textContent = `${can.artikelnummer ? `Nr ${can.artikelnummer} · ` : ""}GTIN ${can.gtin ?? "saknas"} · ${can.mode === "zone" ? "zon" : "punkt"}`;
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
        if (state.colorized) applyColors();
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

/* ---------- Färgsättning ---------- */

async function applyColors({ zoom = false } = {}) {
  const map = colorMap(state.cans?.list() ?? []);
  if (!Object.keys(map).length) {
    await state.client.colorCodeSpaces({});
    state.colorized = false;
    renderPlaced();
    return;
  }
  await state.client.colorCodeSpaces(map);
  if (zoom) state.client.zoomToSearchResult().catch(() => {});
}

colorizeEl.addEventListener("click", async () => {
  try {
    if (state.colorized) {
      await state.client.colorCodeSpaces({});
      state.colorized = false;
      log("Färgsättningen är släckt.");
    } else {
      state.colorized = true;
      await applyColors({ zoom: true });
      const count = Object.keys(colorMap(state.cans.list())).length;
      log(`${count} objekt färgade i produktens färg. Resten av modellen tonas ned. Nya objekt syns i 3D efter ombearbetning.`, "ok");
    }
  } catch (error) {
    state.colorized = false;
    log(`Kunde inte färga burkarna: ${describeError(error)}`, "error");
  }
  renderPlaced();
});

exportEl.addEventListener("click", () => {
  const csv = toCsv(state.cans.list());
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "olburkar.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  log("CSV med kategori, artikelnummer, GTIN och antal exporterad.", "ok");
});

/* ---------- Fota burk ---------- */

const photoEl = $("#photo");
const photoResultEl = $("#photo-result");
const photoPreviewEl = $("#photo-preview");
const photoProgressEl = $("#photo-progress");
const photoStatusEl = $("#photo-status");
const candidatesEl = $("#candidates");
const ocrDetailsEl = $("#ocr-details");
const ocrTextEl = $("#ocr-text");

function setProgress(value, label) {
  photoProgressEl.hidden = value == null;
  photoProgressEl.firstElementChild.style.width = `${Math.round((value ?? 0) * 100)}%`;
  if (label) photoStatusEl.textContent = label;
}

let lastBarcode = null;

function renderCandidates(results) {
  candidatesEl.replaceChildren();
  for (const { beer, score, reasons } of results.slice(0, 3)) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "beer";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = `#${beer.farg}`;
    const text = document.createElement("span");
    text.className = "beer-text";
    const title = document.createElement("b");
    title.textContent = `${beer.namn} ${cl(beer)}`;
    const meta = document.createElement("small");
    meta.textContent = `${refLabel(beer)} · ${reasons.join(", ") || "svag träff"}`;
    text.append(title, meta);
    const badge = document.createElement("span");
    badge.className = `badge ${score >= 0.75 ? "ok" : score >= 0.45 ? "missing" : "bad"}`;
    badge.textContent = `${Math.round(score * 100)} %`;
    button.append(swatch, text, badge);
    button.addEventListener("click", () => {
      if (lastBarcode && !gtinFor(beer) && isValidGtin(lastBarcode)) {
        saveOverride(beer.id, lastBarcode);
        log(`Streckkoden ${lastBarcode} sparad som GTIN för ${beer.namn}.`, "ok");
      }
      select(beer);
      log(`Fotot kopplat till ${beer.namn} ${cl(beer)} (${refLabel(beer)}).`, "ok");
      selectedEl.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    item.append(button);
    candidatesEl.append(item);
  }
}

photoEl.addEventListener("change", async () => {
  const file = photoEl.files?.[0];
  photoEl.value = "";
  if (!file) return;
  photoResultEl.hidden = false;
  candidatesEl.replaceChildren();
  ocrDetailsEl.hidden = true;
  if (photoPreviewEl.src) URL.revokeObjectURL(photoPreviewEl.src);
  photoPreviewEl.src = URL.createObjectURL(file);
  setProgress(0, "Förbereder bilden…");

  try {
    const image = await prepareImage(file);
    const barcode = await detectBarcodes(image.bitmap);
    const opts = { gtinFor, barcodes: barcode.codes };
    lastBarcode = barcode.codes.find((code) => isValidGtin(code)) ?? null;
    if (barcode.codes.length) log(`Streckkod läst: ${barcode.codes.join(", ")}.`);

    let results = barcode.codes.length ? matchBeers("", catalog, opts) : [];
    if (results[0]?.score === 1) {
      setProgress(null, "Streckkoden matchar en öl i katalogen.");
      renderCandidates(results);
      select(results[0].beer);
      log(`Streckkod ${barcode.codes[0]} → ${results[0].beer.namn} (${refLabel(results[0].beer)}).`, "ok");
      return;
    }
    if (barcode.codes.length) {
      log(`Streckkoden ${barcode.codes[0]} finns inte i katalogen. Läser texten i stället. Väljer du en öl utan GTIN sparas streckkoden på den.`, "warn");
    }

    const { text, confidence } = await recognizeText(image.gray, (value, label) => setProgress(value, `${label}…`));
    ocrTextEl.textContent = text.trim() || "(ingen text hittades)";
    ocrDetailsEl.hidden = false;
    results = matchBeers(text, catalog, opts);
    if (!results.length) {
      setProgress(null, "Hittade ingen öl i katalogen som liknar texten. Fota närmare och rakt mot namnet, eller sök manuellt.");
      log(`OCR (säkerhet ${Math.round(confidence)} %) gav ingen träff.`, "warn");
      return;
    }
    const best = results[0];
    setProgress(null, best.score >= 0.75 ? "Trolig träff. Bekräfta genom att välja den." : "Osäker träff. Välj rätt öl nedan.");
    renderCandidates(results);
    log(`OCR: bästa förslag ${best.beer.namn} ${cl(best.beer)} (${Math.round(best.score * 100)} %).`);
  } catch (error) {
    setProgress(null, `Kunde inte läsa bilden: ${describeError(error)}`);
    log(`Bildläsning misslyckades: ${describeError(error)}`, "error");
  }
});

/* ---------- Mock-simulator ---------- */

function renderChips(client) {
  chipsEl.replaceChildren();
  // Rum och riskobjekt har egna mock-vyer i sina flikar.
  for (const object of objects.filter((item) => !item.guid.startsWith("MOCK-ROOM-") && !item.guid.startsWith("MOCK-RISK-"))) {
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

/* ---------- Flikar ---------- */

let activeTab = "beer";
let roomColors = null;
let riskCheck = null;
const tabsEl = $(".tabs");

tabsEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-tab]");
  if (!button) return;
  activeTab = button.dataset.tab;
  for (const tab of tabsEl.querySelectorAll("button")) {
    const on = tab === button;
    tab.classList.toggle("on", on);
    tab.setAttribute("aria-selected", String(on));
  }
  for (const panel of document.querySelectorAll("[data-panel]")) panel.hidden = panel.dataset.panel !== activeTab;
  if (activeTab !== "beer" && state.armed) {
    state.armed = false;
    updateArm();
  }
});

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
      if (result?.guid) {
        roomColors?.picked(result.guid);
        if (activeTab === "risk") riskCheck?.picked(result.guid);
      }
    },
    onFloorChanged(floorId) {
      roomColors?.floorChanged(floorId);
    },
  }),
);

roomColors = createRoomColors({ ready, mount: $("#tab-rooms"), log: (message) => log(`Rum: ${message}`, "warn") });
riskCheck = createRiskCheck({ ready, mount: $("#tab-risk"), log: (message) => log(`Arbetsmiljö: ${message}`, "warn") });

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
      log(`Ansluten (${modeLabel[client.mode]}), projekt ${projectId}. ${catalog.filter((p) => p.kategori === "öl").length} öl och ${catalog.filter((p) => p.kategori === "snus").length} snus i katalogen.`, "ok");
    }
    updateArm();
  })
  .catch((error) => {
    statusEl.dataset.mode = "error";
    statusEl.textContent = modeLabel.error;
    simulatorEl.hidden = true;
    log(describeError(error), "error");
  });
