/**
 * Fota en ölburk → hitta ölen i katalogen.
 *
 * 1. Streckkod: BarcodeDetector (inbyggt i Chrome/Edge på Android, macOS och
 *    ChromeOS) läser EAN-13 direkt. Träff på GTIN = säker matchning.
 * 2. OCR: Tesseract.js (svenska + engelska) laddas från CDN först när den
 *    behövs, så inget nytt npm-paket och ingen kostnad vid start.
 * 3. Matchning: fuzzy jämförelse av texten mot namn, producent, volym,
 *    alkoholhalt, artikelnummer och GTIN i katalogen.
 */

const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
const MAX_SIDE = 1600;

let tesseractPromise = null;
let workerPromise = null;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  tesseractPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TESSERACT_URL;
    script.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error("Tesseract.js laddade inte.")));
    script.onerror = () => {
      tesseractPromise = null;
      reject(new Error("Kunde inte ladda OCR-motorn (Tesseract.js från jsdelivr)."));
    };
    document.head.append(script);
  });
  return tesseractPromise;
}

let progressHandler = () => {};

async function getWorker() {
  workerPromise ??= loadTesseract()
    .then((Tesseract) =>
      Tesseract.createWorker(["swe", "eng"], 1, {
        logger: (message) => progressHandler(message),
      }),
    )
    .catch((error) => {
      workerPromise = null;
      throw error;
    });
  return workerPromise;
}

/** Läser bildfilen, skalar ned och ger en canvas (gråskala + kontrast för OCR). */
export async function prepareImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => createImageBitmap(file));
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const color = document.createElement("canvas");
  color.width = width;
  color.height = height;
  color.getContext("2d").drawImage(bitmap, 0, 0, width, height);

  const gray = document.createElement("canvas");
  gray.width = width;
  gray.height = height;
  const ctx = gray.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(color, 0, 0);
  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;
  let min = 255;
  let max = 0;
  const lum = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 1) {
    const value = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    lum[j] = value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const range = Math.max(1, max - min);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 1) {
    const value = ((lum[j] - min) * 255) / range;
    px[i] = px[i + 1] = px[i + 2] = value;
  }
  ctx.putImageData(image, 0, 0);
  return { bitmap, color, gray };
}

/** EAN/GTIN via BarcodeDetector om webbläsaren har det. */
export async function detectBarcodes(source) {
  if (!("BarcodeDetector" in window)) return { supported: false, codes: [] };
  try {
    const formats = await window.BarcodeDetector.getSupportedFormats?.();
    const wanted = ["ean_13", "ean_8", "upc_a", "upc_e"].filter((format) => !formats || formats.includes(format));
    const detector = new window.BarcodeDetector({ formats: wanted });
    const found = await detector.detect(source);
    return { supported: true, codes: found.map((code) => code.rawValue) };
  } catch {
    return { supported: true, codes: [] };
  }
}

/** Kör OCR. onProgress får 0–1 och en statustext. */
export async function recognizeText(canvas, onProgress = () => {}) {
  progressHandler = (message) => {
    const labels = {
      "loading tesseract core": "Laddar OCR-motor",
      "initializing tesseract": "Startar OCR",
      "loading language traineddata": "Laddar språkdata",
      "initializing api": "Startar OCR",
      "recognizing text": "Läser text",
    };
    onProgress(message.progress ?? 0, labels[message.status] ?? message.status);
  };
  const worker = await getWorker();
  const { data } = await worker.recognize(canvas);
  return { text: data.text ?? "", confidence: data.confidence ?? 0 };
}

/* ---------- Matchning ---------- */

export function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[åä]/g, "a")
    .replace(/ö/g, "o")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9%,.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(text) {
  return normalize(text)
    .split(" ")
    .map((word) => word.replace(/^[.,]+|[.,]+$/g, ""))
    .filter((word) => word.length >= 2);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = temp;
    }
  }
  return row[b.length];
}

/** Likhet 0–1 mellan ett katalogord och bästa ordet (eller ordpar) i OCR-texten. */
function bestSimilarity(target, ocrWords) {
  let best = 0;
  for (let i = 0; i < ocrWords.length; i += 1) {
    const candidates = [ocrWords[i], ocrWords[i] + (ocrWords[i + 1] ?? "")];
    for (const word of candidates) {
      if (Math.abs(word.length - target.length) > Math.max(2, target.length / 2)) continue;
      const similarity = 1 - levenshtein(word, target) / Math.max(word.length, target.length);
      if (similarity > best) best = similarity;
    }
  }
  return best;
}

const STOP = new Set(["ol", "the", "och", "of", "brewery", "bryggeri", "brewing", "co"]);

function nameScore(name, ocrWords) {
  const targets = words(name).filter((word) => word.length >= 3 && !STOP.has(word));
  if (!targets.length) return 0;
  let weighted = 0;
  let total = 0;
  for (const target of targets) {
    const similarity = bestSimilarity(target, ocrWords);
    weighted += target.length * (similarity >= 0.6 ? similarity : 0);
    total += target.length;
  }
  return weighted / total;
}

function readAbv(text) {
  const values = [];
  for (const match of text.matchAll(/(\d{1,2})\s*[,.]\s*(\d)\s*(?:%|vol|alc)/gi)) {
    values.push(Number(`${match[1]}.${match[2]}`));
  }
  return values;
}

function readVolumes(text) {
  const values = [];
  for (const match of text.matchAll(/(\d{2,3})\s*(cl|ml)\b/gi)) {
    const amount = Number(match[1]);
    values.push(match[2].toLowerCase() === "cl" ? amount * 10 : amount);
  }
  return values;
}

function readDigits(text) {
  return (text.match(/\d[\d\s]{6,16}\d/g) ?? []).map((run) => run.replace(/\s/g, ""));
}

/**
 * Rankar katalogen mot OCR-text och/eller streckkoder.
 * @returns {Array<{ beer, score: number, reasons: string[] }>}
 */
export function matchBeers(text, catalog, { gtinFor = (beer) => beer.gtin, barcodes = [] } = {}) {
  const raw = String(text ?? "");
  const ocrWords = words(raw);
  const abvs = readAbv(raw);
  const volumes = readVolumes(raw);
  const digits = [...readDigits(raw), ...barcodes];

  const results = catalog.map((beer) => {
    const reasons = [];
    const gtin = gtinFor(beer);
    if (gtin && barcodes.includes(gtin)) {
      return { beer, score: 1, reasons: ["Streckkoden matchar GTIN"] };
    }
    if (gtin && digits.includes(gtin)) {
      return { beer, score: 0.98, reasons: ["GTIN finns i texten"] };
    }
    if (digits.some((run) => run.includes(beer.artikelnummer))) {
      return { beer, score: 0.95, reasons: ["Artikelnumret finns i texten"] };
    }

    const name = nameScore(beer.namn, ocrWords);
    const producer = nameScore(beer.producent, ocrWords);
    let score = 0.7 * name + 0.15 * producer;
    if (name > 0) reasons.push(`namn ${Math.round(name * 100)} %`);
    if (producer > 0) reasons.push(`producent ${Math.round(producer * 100)} %`);

    if (abvs.length) {
      if (abvs.some((abv) => Math.abs(abv - beer.alkohol) < 0.051)) {
        score += 0.1;
        reasons.push(`${String(beer.alkohol).replace(".", ",")} %`);
      } else {
        score -= 0.1;
      }
    }
    if (volumes.length) {
      if (volumes.includes(beer.volymMl)) {
        score += 0.05;
        reasons.push(`${beer.volymMl / 10} cl`);
      } else {
        score -= 0.05;
      }
    }
    return { beer, score: Math.max(0, Math.min(0.94, score)), reasons };
  });

  return results.filter((result) => result.score > 0.15).sort((a, b) => b.score - a.score);
}
