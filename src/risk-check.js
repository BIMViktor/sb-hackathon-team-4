/**
 * Riskkollen: arbetsmiljö i modellen.
 *
 * 1. Riskscan: one findObjects call per rule (IFC class or property value) points out
 *    building parts that often carry work environment risks (openings, stairs, roofs,
 *    heavy lifts …). It points to where Bas-P/Bas-U should look; it does not prove a risk.
 * 2. Riskregister: click an object in the model (or "+ Risk" on a finding) and record
 *    category, measure, responsible and status. Saved in this browser (localStorage),
 *    since the hackathon allows no backend. Export to CSV as an appendix to the
 *    arbetsmiljöplan (AFS 2023:3).
 *
 * Viewer calls go through the client from src/streambim.js. Floors are looked up with
 * getObjectInfo for at most MAX_INFO objects, two at a time.
 */

const LIMIT_PER_RULE = 200;
const MAX_INFO = 150;
const STORE_KEY = "riskkollen:v1";

/** Rules: edit freely. key/value are exact matches against the model (as in StreamBIM search). */
const DEFAULT_RULES = [
  { id: "fall", label: "Fallrisk", color: "e5484d", hint: "Skyddsräcke, täckning av öppningar, fallskydd", queries: [
    { key: "@kind", value: "Opening element" }, { key: "@kind", value: "Stair" }, { key: "@kind", value: "Stair flight" },
    { key: "@kind", value: "Ramp" }, { key: "@kind", value: "Ramp flight" },
  ] },
  { id: "roof", label: "Takarbete", color: "f76b15", hint: "Fallskydd vid takfot, väderskydd, heta arbeten vid tätskikt", queries: [
    { key: "@kind", value: "Roof" },
  ] },
  { id: "lift", label: "Tunga lyft", color: "8e4ec6", hint: "Lyftplan, lyftredskap, avspärrning under last", queries: [
    { key: "@kind", value: "Beam" }, { key: "@kind", value: "Column" }, { key: "@kind", value: "Element assembly" },
  ] },
  { id: "shaft", label: "Schakt och hissar", color: "3e63dd", hint: "Täckning, avspärrning, arbete i schakt", queries: [
    { key: "@kind", value: "Transport element" }, { key: "Name", value: "Schakt" },
  ] },
];

const CATEGORIES = ["Fallrisk", "Takarbete", "Tunga lyft", "Schakt och hissar", "Ras/skred", "El", "Buller/vibrationer", "Farliga ämnen", "Trafik på arbetsplats", "Övrigt"];
const ROLES = ["Bas-P", "Bas-U", "Projektör", "Entreprenör", "Byggherre"];
const LEVELS = { 1: "Låg", 2: "Medel", 3: "Hög" };
const LEVEL_COLOR = { 1: "30a46c", 2: "f76b15", 3: "e5484d" };

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const today = () => new Date().toISOString().slice(0, 10);

function nameOf(info, guid) {
  const p = info?.properties ?? info?.props ?? {};
  return info?.name || p.Name || p["Long Name"] || guid;
}
function kindOf(info) {
  const p = info?.properties ?? info?.props ?? {};
  return info?.type || p["@kind"] || "";
}
function floorOf(info) {
  const s = info?.properties?.["@Building Storey"];
  return (s && typeof s === "object" ? s.Name : s) || info?.floor || "";
}

export function createRiskCheck({ ready, mount, log = () => {} }) {
  const state = {
    client: null,
    projectId: "",
    rules: DEFAULT_RULES.map((r) => ({ ...r, queries: [...r.queries] })),
    findings: {}, // ruleId -> [{ guid, name, kind, floor }]
    openRule: "",
    register: [],
    draft: null, // risk being edited
    filter: "open",
    scanning: false,
  };

  mount.innerHTML = `
    <div class="rk-head">
      <h2>Arbetsmiljö</h2>
      <button type="button" class="rk-scan primary">Scanna risker</button>
    </div>
    <p class="note rk-status">Pekar ut byggdelar som ofta innebär arbetsmiljörisker. Underlag för Bas-P och Bas-U, inte en färdig riskbedömning.</p>

    <div class="rk-cats"></div>
    <div class="rk-floors"></div>
    <ul class="rk-found"></ul>

    <details class="rk-rules">
      <summary>Lägg till egen sökregel</summary>
      <div class="rk-rule-form">
        <input class="rk-r-label" placeholder="Kategori, t.ex. Rivning">
        <input class="rk-r-key" placeholder="Egenskap, t.ex. Status">
        <input class="rk-r-value" placeholder="Värde, t.ex. Rivs">
        <button type="button" class="rk-r-add">Lägg till</button>
      </div>
    </details>

    <section class="rk-register">
      <div class="rk-head">
        <h3>Riskregister <span class="rk-count"></span></h3>
        <select class="rk-filter">
          <option value="open">Öppna</option><option value="done">Åtgärdade</option><option value="all">Alla</option>
        </select>
      </div>
      <p class="note">Klicka på ett objekt i modellen eller på <b>+ Risk</b> i listan ovan för att registrera en risk.</p>
      <form class="rk-form" hidden>
        <p class="rk-obj"></p>
        <label>Kategori <select name="category">${CATEGORIES.map((c) => `<option>${c}</option>`).join("")}</select></label>
        <label>Allvarlighet <select name="level"><option value="3">Hög</option><option value="2" selected>Medel</option><option value="1">Låg</option></select></label>
        <label class="wide">Risk / beskrivning <input name="description" placeholder="T.ex. öppning i bjälklag vid trapphus"></label>
        <label class="wide">Åtgärd <input name="measure" placeholder="T.ex. skyddsräcke monteras innan rivning av form"></label>
        <label>Ansvarig <select name="role">${ROLES.map((r) => `<option>${r}</option>`).join("")}</select></label>
        <label>Klart senast <input name="due" type="date"></label>
        <div class="rk-form-actions wide">
          <button type="submit" class="primary">Spara risk</button>
          <button type="button" class="rk-cancel">Avbryt</button>
        </div>
      </form>
      <ul class="rk-list"></ul>
      <div class="rk-actions">
        <button type="button" class="rk-export">Exportera CSV</button>
        <button type="button" class="rk-mark-open">Markera öppna i modellen</button>
      </div>
    </section>`;

  const $ = (sel) => mount.querySelector(sel);

  /* ---------- Storage (this browser only) ---------- */

  const storeKey = () => `${STORE_KEY}:${state.projectId || "okänt"}`;
  function loadRegister() {
    try {
      state.register = JSON.parse(localStorage.getItem(storeKey()) || "[]");
    } catch {
      state.register = [];
    }
  }
  function saveRegister() {
    try {
      localStorage.setItem(storeKey(), JSON.stringify(state.register));
    } catch (err) {
      log(`Kunde inte spara lokalt: ${err?.message || err}`);
    }
  }

  ready.then(async (client) => {
    state.client = client;
    try {
      state.projectId = String(await client.getProjectId());
    } catch {
      /* mock or error: keep default key */
    }
    loadRegister();
    renderRegister();
  });

  /* ---------- Scan ---------- */

  async function scan() {
    if (state.scanning) return;
    state.scanning = true;
    $(".rk-scan").disabled = true;
    const client = (state.client = await ready);
    state.findings = {};
    const infoBudget = { left: MAX_INFO };
    try {
      for (const rule of state.rules) {
        $(".rk-status").textContent = `Söker: ${rule.label} …`;
        const guids = new Set();
        for (const q of rule.queries) {
          try {
            (await client.findObjects({ ...q, limit: LIMIT_PER_RULE })).forEach((g) => guids.add(g));
          } catch (err) {
            log(`Sökning ${q.key}=${q.value} misslyckades: ${err?.message || JSON.stringify(err)}`);
          }
        }
        state.findings[rule.id] = [...guids].map((guid) => ({ guid, name: guid, kind: "", floor: "" }));
      }
      renderScan();
      await describeFindings(infoBudget);
      const total = Object.values(state.findings).reduce((s, l) => s + l.length, 0);
      $(".rk-status").textContent = total
        ? `${total} objekt att granska${infoBudget.left <= 0 ? ` (våning hämtad för de första ${MAX_INFO})` : ""}. Klicka på en kategori.`
        : "Inga träffar. Modellens klassnamn kan skilja sig: lägg till en egen sökregel nedan.";
    } finally {
      state.scanning = false;
      $(".rk-scan").disabled = false;
      renderScan();
    }
  }

  // Name, class and floor for the findings, capped and two at a time.
  async function describeFindings(budget) {
    const queue = Object.values(state.findings).flat().filter((f) => budget.left-- > 0);
    const worker = async () => {
      while (queue.length) {
        const f = queue.shift();
        try {
          const info = await state.client.getObjectInfo(f.guid);
          f.name = nameOf(info, f.guid);
          f.kind = kindOf(info);
          f.floor = floorOf(info);
        } catch {
          /* keep the GUID */
        }
      }
    };
    await Promise.all([worker(), worker()]);
  }

  /* ---------- Rendering ---------- */

  function renderScan() {
    const rules = state.rules.filter((r) => state.findings[r.id]);
    $(".rk-cats").innerHTML = rules
      .map((r) => {
        const n = state.findings[r.id].length;
        return `<button type="button" class="rk-cat ${state.openRule === r.id ? "on" : ""} ${n ? "" : "zero"}" data-rule="${r.id}">
          <span class="rk-sw" style="background:#${r.color}"></span><b>${n}</b><span>${esc(r.label)}</span></button>`;
      })
      .join("");

    // Per floor: how many findings in each category
    const byFloor = new Map();
    for (const r of rules) {
      for (const f of state.findings[r.id]) {
        const key = f.floor || "Okänd våning";
        if (!byFloor.has(key)) byFloor.set(key, {});
        byFloor.get(key)[r.id] = (byFloor.get(key)[r.id] || 0) + 1;
      }
    }
    const max = Math.max(1, ...[...byFloor.values()].map((o) => Object.values(o).reduce((a, b) => a + b, 0)));
    $(".rk-floors").innerHTML = byFloor.size
      ? `<p class="note">Per våning</p>` +
        [...byFloor]
          .map(([floor, counts]) => {
            const total = Object.values(counts).reduce((a, b) => a + b, 0);
            const segs = rules.filter((r) => counts[r.id]).map((r) => `<i style="width:${(100 * counts[r.id]) / max}%;background:#${r.color}" title="${esc(r.label)}: ${counts[r.id]}"></i>`).join("");
            return `<button type="button" class="rk-floor" data-floor="${esc(floor)}"><span>${esc(floor)}</span><span class="rk-bar">${segs}</span><b>${total}</b></button>`;
          })
          .join("")
      : "";

    const rule = state.rules.find((r) => r.id === state.openRule);
    const list = rule ? state.findings[rule.id] || [] : [];
    $(".rk-found").innerHTML = rule
      ? `<li class="rk-found-head"><span>${esc(rule.label)}: ${esc(rule.hint || "")}</span></li>` +
        (list.length
          ? list
              .slice(0, 80)
              .map((f) => `<li data-guid="${esc(f.guid)}"><span>${esc(f.name)} <small>${esc([f.kind, f.floor].filter(Boolean).join(" · "))}</small></span>
                <button type="button" class="rk-add" data-guid="${esc(f.guid)}" data-rule="${rule.id}">+ Risk</button></li>`)
              .join("") + (list.length > 80 ? `<li class="note">… och ${list.length - 80} till</li>` : "")
          : `<li class="note">Inga träffar för den här kategorin.</li>`)
      : "";
  }

  function renderRegister() {
    const items = state.register.filter((r) => state.filter === "all" || (state.filter === "open" ? r.status !== "done" : r.status === "done"));
    const open = state.register.filter((r) => r.status !== "done").length;
    $(".rk-count").textContent = `(${open} öppna / ${state.register.length})`;
    items.sort((a, b) => b.level - a.level || String(a.due || "9").localeCompare(String(b.due || "9")));
    $(".rk-list").innerHTML = items.length
      ? items
          .map((r) => {
            const late = r.status !== "done" && r.due && r.due < today();
            return `<li data-id="${r.id}" class="${r.status === "done" ? "done" : ""}">
              <span class="rk-lvl" style="background:#${LEVEL_COLOR[r.level]}" title="${LEVELS[r.level]}"></span>
              <div>
                <b>${esc(r.category)}</b> · ${esc(r.objectName || "utan objekt")} <small>${esc(r.floor || "")}</small>
                <p>${esc(r.description || "–")}</p>
                <p class="note">Åtgärd: ${esc(r.measure || "–")} · ${esc(r.role)}${r.due ? ` · <span class="${late ? "late" : ""}">${late ? "försenad " : ""}${esc(r.due)}</span>` : ""}</p>
              </div>
              <div class="rk-li-actions">
                ${r.guid ? `<button type="button" data-act="goto" title="Visa i modellen">⌖</button>` : ""}
                <button type="button" data-act="toggle" title="${r.status === "done" ? "Öppna igen" : "Markera åtgärdad"}">${r.status === "done" ? "↺" : "✓"}</button>
                <button type="button" data-act="delete" title="Ta bort">✕</button>
              </div></li>`;
          })
          .join("")
      : `<li class="note">${state.register.length ? "Inga risker i det här filtret." : "Inga registrerade risker än."}</li>`;
  }

  /* ---------- Register form ---------- */

  async function openForm({ guid = "", ruleId = "" } = {}) {
    const form = $(".rk-form");
    const finding = Object.values(state.findings).flat().find((f) => f.guid === guid);
    let name = finding?.name || guid;
    let floor = finding?.floor || "";
    if (guid && !finding?.floor && state.client) {
      try {
        const info = await state.client.getObjectInfo(guid);
        name = nameOf(info, guid);
        floor = floorOf(info);
      } catch {
        /* keep GUID */
      }
    }
    const rule = state.rules.find((r) => r.id === ruleId);
    state.draft = { guid, objectName: name, floor };
    form.reset();
    if (rule && CATEGORIES.includes(rule.label)) form.category.value = rule.label;
    else if (rule) form.category.value = "Övrigt";
    if (rule?.hint) form.measure.placeholder = rule.hint;
    form.due.value = "";
    $(".rk-obj").innerHTML = guid ? `Objekt: <b>${esc(name)}</b> <small>${esc(floor)}</small>` : "Risk utan objekt";
    form.hidden = false;
    form.description.focus();
  }

  $(".rk-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    state.register.push({
      id: `r${Date.now().toString(36)}`,
      created: today(),
      ...state.draft,
      category: f.category.value,
      level: Number(f.level.value),
      description: f.description.value.trim(),
      measure: f.measure.value.trim(),
      role: f.role.value,
      due: f.due.value,
      status: "open",
    });
    saveRegister();
    f.hidden = true;
    state.draft = null;
    state.filter = "open";
    $(".rk-filter").value = "open";
    renderRegister();
  });
  $(".rk-cancel").addEventListener("click", () => {
    $(".rk-form").hidden = true;
    state.draft = null;
  });

  /* ---------- Viewer helpers ---------- */

  async function show(guid) {
    try {
      await state.client.gotoObject(guid);
      await state.client.highlightObject(guid);
    } catch (err) {
      log(`Kunde inte visa objektet: ${err?.message || err}`);
    }
  }

  function clearSelection() {
    try {
      state.client.deHighlightAllObjects(); // never resolves in StreamBIM: fire and forget
    } catch {
      /* ignore */
    }
  }

  async function markMany(guids) {
    clearSelection();
    await new Promise((r) => setTimeout(r, 60));
    for (const g of guids.slice(0, 60)) await state.client.highlightObject(g).catch(() => {});
  }

  /* ---------- Events ---------- */

  $(".rk-scan").addEventListener("click", scan);
  mount.addEventListener("click", (e) => {
    const cat = e.target.closest(".rk-cat");
    if (cat) {
      state.openRule = state.openRule === cat.dataset.rule ? "" : cat.dataset.rule;
      renderScan();
      if (state.openRule) markMany((state.findings[state.openRule] || []).map((f) => f.guid));
      return;
    }
    const floorBtn = e.target.closest(".rk-floor");
    if (floorBtn) {
      state.client.getFloors().then((floors) => {
        const f = floors.find((x) => x.name === floorBtn.dataset.floor);
        if (f) state.client.gotoFloor(f.id).catch(() => {});
      });
      return;
    }
    const add = e.target.closest(".rk-add");
    if (add) {
      openForm({ guid: add.dataset.guid, ruleId: add.dataset.rule });
      return;
    }
    const found = e.target.closest(".rk-found li[data-guid]");
    if (found) {
      show(found.dataset.guid);
      return;
    }
    const act = e.target.closest(".rk-li-actions button");
    if (act) {
      const id = act.closest("li").dataset.id;
      const r = state.register.find((x) => x.id === id);
      if (!r) return;
      if (act.dataset.act === "goto") show(r.guid);
      if (act.dataset.act === "toggle") {
        r.status = r.status === "done" ? "open" : "done";
        r.closed = r.status === "done" ? today() : "";
      }
      if (act.dataset.act === "delete") {
        if (!confirmDelete(r)) return;
        state.register = state.register.filter((x) => x.id !== id);
      }
      saveRegister();
      renderRegister();
    }
  });

  // Inline confirm (browser dialogs can freeze the StreamBIM iframe)
  function confirmDelete(r) {
    if (r._confirm) return true;
    r._confirm = true;
    setTimeout(() => delete r._confirm, 2500);
    log("Klicka ✕ igen inom 2 s för att ta bort.");
    const li = mount.querySelector(`.rk-list li[data-id="${r.id}"] [data-act="delete"]`);
    if (li) li.textContent = "Ta bort?";
    return false;
  }

  $(".rk-filter").addEventListener("change", (e) => {
    state.filter = e.target.value;
    renderRegister();
  });
  $(".rk-mark-open").addEventListener("click", () => markMany(state.register.filter((r) => r.status !== "done" && r.guid).map((r) => r.guid)));
  $(".rk-r-add").addEventListener("click", () => {
    const label = $(".rk-r-label").value.trim();
    const key = $(".rk-r-key").value.trim();
    const value = $(".rk-r-value").value.trim();
    if (!label || !key || !value) return;
    const existing = state.rules.find((r) => r.label.toLowerCase() === label.toLowerCase());
    if (existing) existing.queries.push({ key, value });
    else state.rules.push({ id: `c${state.rules.length}`, label, color: "12a594", hint: "", queries: [{ key, value }] });
    $(".rk-r-key").value = $(".rk-r-value").value = "";
    $(".rk-status").textContent = `Regel tillagd: ${label} (${key} = ${value}). Kör Scanna risker igen.`;
  });

  $(".rk-export").addEventListener("click", () => {
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["Status", "Allvarlighet", "Kategori", "Objekt", "Våning", "Risk", "Åtgärd", "Ansvarig", "Klart senast", "Skapad", "Åtgärdad", "GUID"];
    const rows = state.register.map((r) => [r.status === "done" ? "Åtgärdad" : "Öppen", LEVELS[r.level], r.category, r.objectName, r.floor, r.description, r.measure, r.role, r.due, r.created, r.closed, r.guid]);
    const scanRows = state.rules
      .filter((r) => state.findings[r.id]?.length)
      .map((r) => ["Scan", "", r.label, `${state.findings[r.id].length} objekt`, "", r.hint, "", "", "", today(), "", ""]);
    const csv = [head, ...rows, ...scanRows].map((row) => row.map(q).join(";")).join("\r\n");
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" })),
      download: `riskregister_${today()}.csv`,
    });
    document.body.append(a);
    a.click();
    a.remove();
  });

  return {
    /** Call from onPickedObject while the Arbetsmiljö tab is open. */
    picked(guid) {
      openForm({ guid });
    },
  };
}
