/**
 * Egenkontroll öldrickning.
 *
 * Tänds när en öl identifieras med kameran (streckkod eller OCR) eller startas
 * manuellt för en vald öl. Varje kontrollpunkt får OK, Avvikelse (med kommentar)
 * eller Ej aktuell. När alla punkter är besvarade kan kontrollen klarmarkeras.
 *
 * StreamBIM:s checklist-API (jonatanjacobsson/streambim-api-docs, api/checklists.md)
 * beskriver bara läsning och export, inte hur man skapar checklistor eller svar.
 * Egenkontrollerna sparas därför i webbläsaren per projekt (localStorage) och kan
 * exporteras som CSV. En klarmarkerad egenkontroll följer med som egenskaper när
 * en burk av samma öl ställs ut i modellen.
 */

export const TITLE = "Egenkontroll öldrickning";

export const POINTS = [
  { id: "arbetstid", text: "Arbetsdagen är avslutad. Ingen alkohol under arbetstid." },
  { id: "plats", text: "Inte på arbetsplatsen, i bodar eller i arbetsfordon." },
  { id: "fordon", text: "Ingen bil- eller maskinkörning efteråt." },
  { id: "inkop", text: "Köpt på Systembolaget av någon som har fyllt 20 år." },
  { id: "produkt", text: "Burken stämmer med produktbladet (artikelnummer och GTIN)." },
  { id: "temperatur", text: "Serveringstemperatur enligt produktbladet." },
  { id: "vatten", text: "Vatten och mat finns tillgängligt." },
  { id: "pant", text: "Burken pantas efteråt." },
];

export const ANSWERS = [
  { value: "ok", label: "OK" },
  { value: "avvikelse", label: "Avvikelse" },
  { value: "ej", label: "Ej aktuell" },
];

/** Ny egenkontroll för en öl. källa: "streckkod", "OCR" eller "manuell". */
export function createCheck(beer, { gtin, source = "manuell", by = "" } = {}) {
  const now = new Date().toISOString();
  const answers = Object.fromEntries(POINTS.map((point) => [point.id, { value: "", comment: "" }]));
  // En streckkod som matchar katalogens GTIN bekräftar produkten.
  if (source === "streckkod" && gtin) answers.produkt = { value: "ok", comment: `GTIN ${gtin} läst från streckkoden` };
  return {
    id: `ek-${Date.now().toString(36)}`,
    productId: beer.id,
    artikelnummer: beer.artikelnummer,
    gtin: gtin ?? beer.gtin ?? null,
    namn: beer.namn,
    produktblad: beer.url,
    source,
    by,
    started: now,
    done: null,
    answers,
  };
}

/** Status: "pågår", "godkänd" eller "avvikelse". */
export function statusOf(check) {
  const values = POINTS.map((point) => check.answers[point.id]?.value);
  if (!check.done) return "pågår";
  return values.includes("avvikelse") ? "avvikelse" : "godkänd";
}

export function progressOf(check) {
  const answered = POINTS.filter((point) => check.answers[point.id]?.value).length;
  return { answered, total: POINTS.length, complete: answered === POINTS.length };
}

/** Avvikelser kräver kommentar. Returnerar en lista med det som saknas. */
export function problems(check) {
  const out = [];
  for (const point of POINTS) {
    const answer = check.answers[point.id];
    if (!answer?.value) out.push(`Obesvarad: ${point.text}`);
    else if (answer.value === "avvikelse" && !answer.comment.trim()) out.push(`Kommentar saknas: ${point.text}`);
  }
  return out;
}

/** Egenskaper som följer med en utställd burk. */
export function checkProps(check) {
  if (!check?.done) return [];
  return [
    ["Egenkontroll", `${TITLE}: ${statusOf(check)}`],
    ["Egenkontroll datum", check.done.slice(0, 16).replace("T", " ")],
    ["Egenkontroll utförd av", check.by || "okänd"],
  ];
}

export function checksCsv(checks) {
  const cell = (v) => {
    const s = String(v ?? "");
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["Id", "Öl", "Artikelnummer", "GTIN", "Källa", "Utförd av", "Startad", "Klar", "Status", ...POINTS.map((p) => p.text), "Kommentarer"];
  const lines = checks.map((check) => {
    const comments = POINTS.map((p) => check.answers[p.id]?.comment).filter(Boolean).join(" | ");
    return [
      check.id,
      check.namn,
      check.artikelnummer,
      check.gtin,
      check.source,
      check.by,
      check.started,
      check.done ?? "",
      statusOf(check),
      ...POINTS.map((p) => ANSWERS.find((a) => a.value === check.answers[p.id]?.value)?.label ?? ""),
      comments,
    ]
      .map(cell)
      .join(";");
  });
  return [header.join(";"), ...lines].join("\r\n");
}

/** Lokal lagring per projekt. */
export function checkStore(projectId) {
  const key = `egenkontroll:${projectId}`;
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem(key) ?? "[]");
  } catch {
    list = [];
  }
  const persist = () => {
    try {
      localStorage.setItem(key, JSON.stringify(list));
    } catch {
      /* Gäller bara sessionen om lagring är blockerad. */
    }
  };
  return {
    list: () => [...list],
    save(check) {
      list = [check, ...list.filter((item) => item.id !== check.id)];
      persist();
    },
    remove(id) {
      list = list.filter((item) => item.id !== id);
      persist();
    },
    /** Senaste klarmarkerade egenkontroll för en produkt. */
    latestDone(productId) {
      return list.find((item) => item.productId === productId && item.done) ?? null;
    },
  };
}
