/**
 * Panelen "IFC-modell" under Utställt: håller en IFC-fil med alla utställda
 * burkar och dosor, laddar ner den eller publicerar den i StreamBIM.
 * Logiken för filen ligger i ifc-writer.js och uppladdningen i ifc-publish.js.
 */

import { beerGroups, canName } from "./beer.js";
import { sizeFor, strengthLabel } from "./catalog.js";
import { writeIfc } from "./ifc-writer.js";
import { describeApiError, listFolders, listLayers, publishConfig, publishIfc } from "./ifc-publish.js";

const FILE_NAME = "ol-och-snus.ifc";
const DEFAULT_LAYER = "OL_OCH_SNUS";
const AUTO_DELAY_MS = 15000;

export function createIfcPanel({ root, getClient, getCans, findProduct, log }) {
  const $ = (selector) => root.querySelector(selector);
  const state = { config: null, floors: [], publishing: false, timer: null, foldersLoaded: false };

  const stepsEl = $("#ifc-steps");
  const icons = { run: "…", ok: "✓", fail: "✕", skip: "–" };

  function config() {
    state.config ??= publishConfig("okänt");
    return state.config;
  }

  async function init(projectId) {
    state.config = publishConfig(projectId);
    const client = getClient();
    state.floors = (await client.getFloors().catch(() => [])) ?? [];
    const current = config().get();
    $("#ifc-auto").checked = current.auto !== false;
    $("#ifc-layer").value = current.layer ?? DEFAULT_LAYER;
    $("#ifc-dx").value = current.offset?.x ?? 0;
    $("#ifc-dy").value = current.offset?.y ?? 0;
    $("#ifc-dz").value = current.offset?.z ?? 0;
    render();
  }

  /** Bygger IFC-poster av de utställda objekten. */
  function items() {
    const floorName = (can) => {
      const byId = state.floors.find((floor) => String(floor.id) === String(can.floorId));
      if (byId) return byId.name;
      const level = (floor) => Number(floor.elevation ?? floor.height ?? 0);
      const below = [...state.floors].sort((a, b) => level(a) - level(b)).filter((floor) => level(floor) <= (can.center?.[2] ?? 0) + 0.05);
      return below.at(-1)?.name ?? "Okänd våning";
    };
    return getCans()
      .filter((can) => can.ifcGuid && Array.isArray(can.center))
      .map((can) => {
        const product = findProduct(can);
        if (!product) return null;
        const { diameter, height } = sizeFor(product);
        const group = beerGroups(product, can.gtin, can.extraProps ?? [])[0];
        return {
          guid: can.ifcGuid,
          name: canName(product),
          description: `${product.producent}, ${product.stil}, ${strengthLabel(product)}`,
          objectType: product.kategori === "snus" ? "Snusdosa" : "Ölburk",
          tag: product.artikelnummer ?? can.gtin ?? product.gtin,
          center: can.center,
          height,
          diameter,
          color: product.farg,
          floorName: floorName(can),
          psetName: group.label,
          props: group.content.properties.map((prop) => [prop.key, prop.value]),
        };
      })
      .filter(Boolean);
  }

  function buildText() {
    const offset = config().get().offset;
    return writeIfc({ items: items(), floors: state.floors, offset, projectName: "Öl & snus", fileName: FILE_NAME });
  }

  function render() {
    const current = config().get();
    const count = items().length;
    const stateEl = $("#ifc-state");
    const published = Boolean(current.documentId);
    if (state.publishing) {
      stateEl.textContent = "Publicerar";
      stateEl.className = "badge missing";
    } else if (!count) {
      stateEl.textContent = "Tom";
      stateEl.className = "badge";
    } else if (current.dirty || !published) {
      stateEl.textContent = "Ej publicerad";
      stateEl.className = "badge missing";
    } else {
      stateEl.textContent = `Publicerad rev ${current.revision ?? 1}`;
      stateEl.className = "badge ok";
    }
    $("#ifc-summary").textContent = published
      ? `${count} objekt i ${FILE_NAME}. Dokument ${current.documentId}, lager ${current.layer ?? "–"}${current.publishedAt ? `, senast ${new Date(current.publishedAt).toLocaleString("sv-SE")}` : ""}.`
      : `${count} objekt i ${FILE_NAME}. Inte uppladdad till StreamBIM än.`;
    $("#ifc-publish").disabled = state.publishing || !count;
    $("#ifc-download").disabled = !count;
    $("#ifc-folder-row").hidden = published;
    $("#ifc-layer-row").hidden = Boolean(current.ifcFileId);
  }

  function setStep(id, status, text) {
    let li = stepsEl.querySelector(`[data-step="${id}"]`);
    if (!li) {
      li = document.createElement("li");
      li.dataset.step = id;
      stepsEl.append(li);
    }
    li.dataset.status = status;
    li.textContent = `${icons[status] ?? ""} ${text}`;
  }

  async function loadChoices() {
    if (state.foldersLoaded) return;
    const client = getClient();
    const folderEl = $("#ifc-folder");
    folderEl.replaceChildren(new Option("Hämtar mappar…", ""));
    try {
      const [folders, layers] = await Promise.all([listFolders(client), listLayers(client).catch(() => [])]);
      folderEl.replaceChildren(new Option("Välj mapp", ""), ...folders.map((folder) => new Option(folder.name, folder.id)));
      const saved = config().get().folderId;
      if (saved) folderEl.value = saved;
      $("#ifc-layers").replaceChildren(...[DEFAULT_LAYER, ...layers].map((layer) => new Option(layer, layer)));
      state.foldersLoaded = true;
    } catch (error) {
      folderEl.replaceChildren(new Option("Kunde inte hämta mappar", ""));
      log(`IFC: kunde inte hämta mappar: ${describeApiError(error)}`, "error");
    }
  }

  async function publish({ auto = false } = {}) {
    clearTimeout(state.timer);
    if (state.publishing) return;
    const current = config().get();
    const folderId = current.documentId ? current.folderId : $("#ifc-folder").value;
    const layer = ($("#ifc-layer").value || DEFAULT_LAYER).trim();
    if (!current.documentId && !folderId) {
      $("#ifc-settings").open = true;
      await loadChoices();
      log(auto ? "IFC: välj mapp och lager och tryck Publicera för första uppladdningen. Sedan publiceras ändringar automatiskt." : "IFC: välj en mapp för IFC-filen först.", "warn");
      return;
    }
    state.publishing = true;
    stepsEl.replaceChildren();
    render();
    try {
      const text = buildText();
      const result = await publishIfc(getClient(), { text, fileName: FILE_NAME, folderId, layer, config: config(), onStep: setStep });
      config().set({ dirty: false });
      log(
        `IFC publicerad: dokument ${result.documentId} rev ${result.revision}, ${items().length} objekt.${result.converterStarted ? " Konvertering startad." : " Starta konverteringen i StreamBIM."}`,
        result.converterStarted ? "ok" : "warn",
      );
    } catch (error) {
      log(`IFC-publicering stoppades: ${describeApiError(error)}`, "error");
    } finally {
      state.publishing = false;
      render();
    }
  }

  function download() {
    const blob = new Blob([buildText()], { type: "application/octet-stream" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = FILE_NAME;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    log(`IFC nedladdad: ${FILE_NAME} med ${items().length} objekt.`, "ok");
  }

  /** Anropas när ett objekt ställts ut eller tagits bort. */
  function changed() {
    config().set({ dirty: true });
    render();
    const current = config().get();
    if (!current.auto) return;
    clearTimeout(state.timer);
    if (current.documentId) {
      log(`IFC uppdateras i StreamBIM om ${AUTO_DELAY_MS / 1000} s (fler utställningar samlas i samma revision).`);
      state.timer = setTimeout(() => publish({ auto: true }), AUTO_DELAY_MS);
    } else {
      publish({ auto: true });
    }
  }

  $("#ifc-publish").addEventListener("click", () => publish());
  $("#ifc-download").addEventListener("click", download);
  $("#ifc-auto").addEventListener("change", (event) => config().set({ auto: event.target.checked }));
  $("#ifc-settings").addEventListener("toggle", (event) => {
    if (event.target.open) loadChoices();
  });
  $("#ifc-folder").addEventListener("change", (event) => config().set({ folderId: event.target.value }));
  for (const axis of ["x", "y", "z"]) {
    $(`#ifc-d${axis}`).addEventListener("change", (event) => {
      const offset = { ...config().get().offset, [axis]: Number(event.target.value) || 0 };
      config().set({ offset, dirty: true });
      render();
    });
  }
  $("#ifc-forget").addEventListener("click", () => {
    config().set({ documentId: null, ifcFileId: null, revision: null, publishedAt: null, dirty: true });
    stepsEl.replaceChildren();
    render();
    log("IFC: nästa publicering skapar ett nytt dokument. Det gamla ligger kvar i StreamBIM och tas bort där.", "warn");
  });

  return { init, changed, render, buildText };
}
