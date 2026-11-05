/**
 * Katalog: ölburkar från Systembolaget och snusdosor (längre ned).
 *
 * Artikelnummer ("Nr" på systembolaget.se) är kontrollerade mot produktsidorna
 * 2026-11-05. De två sista siffrorna är förpackningskoden (t.ex. 12/32 = burk
 * 50 cl, 15/35 = burk 33 cl). Resten är varunumret.
 *
 * GTIN: Systembolaget publicerar inte GTIN/EAN öppet (produkt-API:t stängdes
 * 2020). GTIN nedan kommer från Open Food Facts och är matchade på varumärke,
 * volym, alkoholhalt och burk. Kontrollsiffran valideras i widgeten. Där vi inte
 * hittat ett GTIN som säkert hör till artikeln står gtin: null. Fyll i från
 * burkens streckkod i widgeten (sparas lokalt) eller i den här filen.
 *
 * Pris är Systembolagets pris exkl. pant vid kontrolltillfället.
 */

const SB = "https://www.systembolaget.se/";
const OFF = "https://world.openfoodfacts.org/product/";

export const catalog = [
  {
    artikelnummer: "141212",
    namn: "Norrlands Guld Export",
    producent: "Spendrups",
    stil: "Ljus lager",
    volymMl: 500,
    alkohol: 5.3,
    prisKr: 16.2,
    gtin: "7310401006758",
    gtinKalla: `${OFF}7310401006758`,
    farg: "d4a017",
  },
  {
    artikelnummer: "144712",
    namn: "Bright Brew",
    producent: "Spendrups",
    stil: "Ljus lager",
    volymMl: 500,
    alkohol: 5,
    prisKr: 16.5,
    gtin: "7310401006963",
    gtinKalla: `${OFF}7310401006963`,
    farg: "8fb8de",
  },
  {
    artikelnummer: "141215",
    namn: "Norrlands Guld Export",
    producent: "Spendrups",
    stil: "Ljus lager",
    volymMl: 330,
    alkohol: 5.3,
    prisKr: 13.2,
    gtin: null,
    farg: "d4a017",
  },
  {
    artikelnummer: "137115",
    namn: "Åbro Original Extra Stark",
    producent: "Åbro Bryggeri",
    stil: "Starkare lager",
    volymMl: 330,
    alkohol: 7.3,
    prisKr: 13.4,
    gtin: null,
    farg: "1f3f8f",
  },
  {
    artikelnummer: "141115",
    namn: "Åbro Original Starköl",
    producent: "Åbro Bryggeri",
    stil: "Ljus lager",
    volymMl: 330,
    alkohol: 5.2,
    prisKr: 12.9,
    gtin: null,
    farg: "c8102e",
  },
  {
    artikelnummer: "1212335",
    namn: "Gränges Klassisk lager",
    producent: "Spendrups Bryggeri",
    stil: "Ljus lager",
    volymMl: 330,
    alkohol: 4,
    prisKr: 10,
    gtin: null,
    farg: "2e7d32",
  },
  {
    artikelnummer: "3142615",
    namn: "Monkish",
    producent: "Bearded Rabbit Brewery",
    stil: "Amerikansk pale ale (APA)",
    volymMl: 330,
    alkohol: 4.8,
    prisKr: 27,
    gtin: null,
    farg: "f28c28",
  },
  {
    artikelnummer: "3073915",
    namn: "Northern Björk",
    producent: "Norrlandsbryggarna",
    stil: "Ljus lager",
    volymMl: 330,
    alkohol: 4.8,
    prisKr: 34.3,
    gtin: null,
    farg: "6d8b74",
  },
  {
    artikelnummer: "3164815",
    namn: "Mariatorgets Östersjöporter",
    producent: "Mariatorgets",
    stil: "Porter",
    volymMl: 330,
    alkohol: 5.5,
    prisKr: 28.8,
    gtin: null,
    farg: "3b2a20",
  },
  {
    artikelnummer: "3045432",
    namn: "Beersmiths The Line",
    producent: "Beersmiths",
    stil: "Öl",
    volymMl: 500,
    alkohol: 5.3,
    prisKr: 27.5,
    gtin: null,
    farg: "455a64",
  },
].map((beer) => ({ ...beer, kategori: "öl", id: beer.artikelnummer, url: `${SB}${beer.artikelnummer}` }));

/**
 * Snus säljs inte på Systembolaget utan i dagligvaruhandeln, så det finns inget
 * Systembolaget-artikelnummer. Snuset identifieras på GTIN (EAN-13 på dosan).
 * GTIN är hämtade från återförsäljares produktsidor 2026-11-05 (källa per rad)
 * och gäller en dosa, inte en stock. Nikotinhalt och vikt enligt samma källor.
 */
const snus = [
  {
    namn: "General Original Portion",
    producent: "Swedish Match",
    stil: "Originalportion",
    viktG: 24,
    portioner: 24,
    nikotinMgG: 8,
    gtin: "7311250448805",
    gtinKalla: "https://samgross.se/general-portion/24-g",
    farg: "1a1a1a",
  },
  {
    namn: "General Original Portion Extra Strong",
    producent: "Swedish Match",
    stil: "Originalportion",
    viktG: 22,
    portioner: 20,
    nikotinMgG: 14,
    gtin: "7311250449505",
    gtinKalla: "https://www.snusport.com/product/general-extra-strong-portion/",
    farg: "8b1a1a",
  },
  {
    namn: "General ONE Original Portion Strong",
    producent: "Swedish Match",
    stil: "Originalportion",
    viktG: 18,
    portioner: 20,
    nikotinMgG: 13,
    gtin: "7311250444470",
    gtinKalla: "https://billigsnus.se/produkt/snus/portionssnus/one-svart/",
    farg: "2b2b2b",
  },
  {
    namn: "General XR Original Slim",
    producent: "Swedish Match",
    stil: "Originalportion, slim",
    viktG: 18.9,
    portioner: 21,
    nikotinMgG: 9.4,
    gtin: "7311250447389",
    gtinKalla: "https://www.snusport.com/product/xr-general-original-slim-portion/",
    farg: "5c5c5c",
  },
  {
    namn: "General Original Mini Portion",
    producent: "Swedish Match",
    stil: "Originalportion, mini",
    viktG: 10.4,
    portioner: 20,
    nikotinMgG: 8,
    gtin: "7311250446665",
    gtinKalla: "https://snusfabriken.com/produkt/portion-general-original-mini-portionssnus/",
    farg: "a07c3c",
  },
].map((item) => ({ ...item, kategori: "snus", artikelnummer: null, prisKr: null, id: `snus-${item.gtin}`, url: item.gtinKalla }));

catalog.push(...snus);

const decimal = (value) => String(value).replace(".", ",");

/** Mått i meter. Snusdosa: nominellt ⌀ 67 × 21 mm. */
export function sizeFor(product) {
  if (product.kategori === "snus") return { diameter: 0.067, height: 0.021 };
  return canSize(product.volymMl);
}

/** "50 cl" eller "24 g". */
export function sizeLabel(product) {
  return product.kategori === "snus" ? `${decimal(product.viktG)} g` : `${product.volymMl / 10} cl`;
}

/** Huvudidentitet: "Nr 141212" för öl, "GTIN 7311…" för snus. */
export function refLabel(product) {
  return product.artikelnummer ? `Nr ${product.artikelnummer}` : `GTIN ${product.gtin}`;
}

/** "5,3 %" eller "8 mg/g". */
export function strengthLabel(product) {
  return product.kategori === "snus" ? `${decimal(product.nikotinMgG)} mg/g` : `${decimal(product.alkohol)} %`;
}

/** Nominella standardmått för aluminiumburk (meter). */
export function canSize(volymMl) {
  if (volymMl >= 480) return { diameter: 0.066, height: 0.168 };
  if (volymMl >= 420) return { diameter: 0.066, height: 0.147 };
  return { diameter: 0.066, height: 0.115 };
}

/** Kontrollerar GTIN-8/12/13/14 (mod 10, vikt 3 och 1 från höger). */
export function isValidGtin(value) {
  const digits = String(value ?? "").replace(/\s/g, "");
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    const digit = Number(body[body.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

/** Varunummer = artikelnummer utan de två sista siffrorna (förpackningskoden). */
export function varunummer(artikelnummer) {
  return artikelnummer ? String(artikelnummer).slice(0, -2) : "";
}
