/**
 * Ställer ut ölburkar som egna objekt i StreamBIM.
 *
 * Två lägen (se jonatanjacobsson/streambim-api-docs, widget/guides/annotations-custom-objects.md):
 *  - "zone": en burkstor zon (@kind Space) via POST /v2/ifc-objects. Har riktig
 *    geometri (diameter × höjd) och kan raderas. Ritas i 3D först när
 *    byggnaden har processats om.
 *  - "annotation": createObject() + PATCH med property set. Syns som punkt
 *    direkt, men en annotation går INTE att radera.
 * Båda får property setet "Systembolaget" med artikelnummer och GTIN.
 */

import { refLabel, sizeFor, sizeLabel, strengthLabel, varunummer } from "./catalog.js";

export const PSET = "Systembolaget";
const SOURCE = "sb-hackathon-team-4 ölburks-widget";

/** Vyns punkt [a, b, c] → byggnadens koordinater [x, y, z] (z upp). */
export function viewerToBuilding([a, b, c]) {
  return [a, c, -b];
}

function prop(key, value) {
  const valueType = typeof value === "number" ? "float8" : typeof value === "boolean" ? "bool" : "str";
  return { key, value, valueType, measure: "", unit: "", valueItem: "" };
}

/** Artikelnummer och GTIN sparas som text så att inga siffror tappas. */
export function beerGroups(beer, gtin, extraProps = []) {
  const extra = extraProps.map(([key, value]) => prop(key, value));
  if (beer.kategori === "snus") {
    return [
      {
        label: "Snus",
        content: {
          properties: [
            prop("GTIN", gtin ? String(gtin) : ""),
            prop("Namn", beer.namn),
            prop("Producent", beer.producent),
            prop("Typ", beer.stil),
            prop("Vikt (g)", beer.viktG),
            prop("Portioner", beer.portioner),
            prop("Nikotin (mg/g)", beer.nikotinMgG),
            prop("Källa GTIN", beer.gtinKalla),
            prop("Källa", SOURCE),
            ...extra,
          ],
        },
      },
    ];
  }
  return [
    {
      label: PSET,
      content: {
        properties: [
          prop("Artikelnummer", String(beer.artikelnummer)),
          prop("Varunummer", varunummer(beer.artikelnummer)),
          prop("GTIN", gtin ? String(gtin) : ""),
          prop("Namn", beer.namn),
          prop("Producent", beer.producent),
          prop("Stil", beer.stil),
          prop("Volym (ml)", beer.volymMl),
          prop("Alkoholhalt (% vol)", beer.alkohol),
          prop("Pris exkl. pant (kr)", beer.prisKr),
          prop("Produktsida", beer.url),
          prop("Källa", SOURCE),
          ...extra,
        ],
      },
    },
  ];
}

export function canName(beer) {
  const kind = beer.kategori === "snus" ? "Snusdosa" : "Ölburk";
  return `${kind} ${beer.namn} ${sizeLabel(beer)} (${refLabel(beer)})`;
}

/** Antal hörn i burkens kontur. 24 ger en nästan rund cylinder. */
export const CAN_SIDES = 24;

/** Regelbunden polygon runt (x, y) som golvkontur, [x1, y1, x2, y2, …]. */
export function canOutline(x, y, diameter, sides = CAN_SIDES) {
  const r = diameter / 2;
  const outline = [];
  for (let i = 0; i < sides; i += 1) {
    const angle = (2 * Math.PI * i) / sides;
    outline.push(round(x + r * Math.cos(angle)), round(y + r * Math.sin(angle)));
  }
  return outline;
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

function parse(text) {
  const json = typeof text === "string" ? JSON.parse(text) : text;
  return json?.data ?? json;
}

export function describeError(error) {
  if (!error) return "Okänt fel";
  if (error.message) return error.message;
  if (error.code) return `${error.code}${error.debug ? `: ${error.debug}` : ""}`;
  return String(error);
}

async function context(client) {
  const [projectId, buildingId] = await Promise.all([client.getProjectId(), client.getBuildingId()]);
  const base = `/project-${projectId}/api/v1/v2/ifc-objects`;
  return {
    projectId,
    buildingId,
    base,
    url: (id) => `${base}/${encodeURIComponent(id)}?building=${buildingId}`,
  };
}

/** Våning: i första hand det klickade objektets, annars högsta våning under punkten. */
async function floorFor(client, ctx, pickedGuid, z) {
  if (pickedGuid) {
    try {
      const record = parse(await client.makeApiRequest({ url: `${ctx.url(pickedGuid)}&_=${Date.now()}` }));
      const id = record?.relationships?.floors?.data?.[0]?.id;
      if (id != null) return String(id);
    } catch {
      /* Faller tillbaka på våningshöjder nedan. */
    }
  }
  const floors = (await client.getFloors()) ?? [];
  const level = (floor) => Number(floor.height ?? floor.elevation ?? 0);
  const sorted = [...floors].sort((a, b) => level(a) - level(b));
  const below = sorted.filter((floor) => level(floor) <= z + 0.05);
  const floor = below.at(-1) ?? sorted[0];
  if (!floor) throw new Error("Hittade ingen våning att ställa burken på.");
  return String(floor.id);
}

/**
 * Ställer ut en burk vid en klickad punkt.
 * @returns {Promise<{ id: string, mode: string, center: number[] }>}
 */
export async function placeCan(client, { beer, gtin, point, pickedGuid, mode = "zone", extraProps = [] }) {
  if (!Array.isArray(point) || point.length !== 3) {
    throw new Error("Klicket saknar en 3D-punkt. Klicka på en yta i modellen.");
  }
  const ctx = await context(client);
  const [x, y, z] = viewerToBuilding(point);
  const { diameter, height } = sizeFor(beer);
  const groups = beerGroups(beer, gtin, extraProps);
  const name = canName(beer);

  if (mode === "annotation") {
    const id = await client.createObject({ center: point, name });
    const current = parse(await client.makeApiRequest({ url: `${ctx.url(id)}&_=${Date.now()}` }));
    const attributes = {
      layer: null,
      properties: { Name: name, "@kind": "Annotation", Description: `GTIN ${gtin || "saknas"}` },
      groups,
      center: current.attributes.center,
      bbox: current.attributes.bbox,
      boundary: current.attributes.boundary,
    };
    const relationships = {
      building: current.relationships?.building,
      floors: current.relationships?.floors,
    };
    await client.makeApiRequest({
      url: ctx.url(id),
      method: "PATCH",
      body: { data: { id, type: "ifc-objects", attributes, relationships } },
    });
    return { id, mode, center: [x, y, z], floorId: current.relationships?.floors?.data?.[0]?.id ?? null };
  }

  const floorId = await floorFor(client, ctx, pickedGuid, z);
  const outline = canOutline(x, y, diameter);
  const bottom = round(z);
  const top = round(z + height);
  const r = diameter / 2;
  const area = round((CAN_SIDES / 2) * r * r * Math.sin((2 * Math.PI) / CAN_SIDES));
  const attributes = {
    layer: null,
    properties: {
      Name: name,
      "Long Name": `GTIN ${gtin || "saknas"}`,
      "@kind": "Space",
      Description: `${beer.producent}, ${beer.stil}, ${strengthLabel(beer)}. ${beer.url}`,
    },
    groups: [
      ...groups,
      {
        label: "BaseQuantities:",
        content: {
          properties: [
            { ...prop("GrossFloorArea", area), measure: "area", unit: "square_metre" },
            { ...prop("Height", round(height * 1000)), measure: "length", unit: "millimetre" },
          ],
        },
      },
    ],
    boundary: outline,
    bbox: [round(x - r), round(y - r), bottom, round(x + r), round(y + r), top],
    center: [round(x), round(y), round((bottom + top) / 2)],
  };
  const relationships = {
    building: { data: { type: "buildings", id: String(ctx.buildingId) } },
    floors: { data: [{ type: "floors", id: floorId }] },
  };
  const record = parse(
    await client.makeApiRequest({
      url: ctx.base,
      method: "POST",
      body: { data: { type: "ifc-objects", attributes, relationships } },
    }),
  );
  if (!record?.id) throw new Error("StreamBIM svarade utan id för den nya burken.");
  return { id: record.id, mode, center: [x, y, z], floorId };
}

/** Färgkarta för colorCodeSpaces: zon-id → ölens färg. Punkter är inga Space och hoppas över. */
export function colorMap(cans) {
  return Object.fromEntries(cans.filter((can) => can.mode === "zone").map((can) => [can.id, `#${can.farg}`]));
}

/** Raderar en zon-burk. Annotationer kan inte raderas i StreamBIM. */
export async function removeCan(client, can) {
  if (can.mode === "annotation") return false;
  const ctx = await context(client);
  await client.makeApiRequest({ url: ctx.url(can.id), method: "DELETE" });
  return true;
}

/** Lokalt register över utställda burkar, per projekt. */
export function registry(projectId) {
  const key = `beer-cans:${projectId}`;
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "[]");
    } catch {
      return [];
    }
  };
  const write = (list) => {
    try {
      localStorage.setItem(key, JSON.stringify(list));
    } catch {
      /* Lagring kan vara blockerad i iframe. Listan gäller då bara sessionen. */
    }
  };
  let memory = read();
  return {
    list: () => [...memory],
    add(can) {
      memory = [can, ...memory];
      write(memory);
    },
    remove(id) {
      memory = memory.filter((can) => can.id !== id);
      write(memory);
    },
  };
}

/** Sammanställning per artikel, som CSV (semikolon för svensk Excel). */
export function toCsv(cans) {
  const rows = new Map();
  for (const can of cans) {
    const key = `${can.productId ?? can.artikelnummer}|${can.gtin ?? ""}`;
    const row = rows.get(key) ?? { ...can, antal: 0 };
    row.antal += 1;
    rows.set(key, row);
  }
  const money = (value) => (value == null ? "" : String(Math.round(value * 100) / 100).replace(".", ","));
  const header = ["Kategori", "Artikelnummer", "GTIN", "Namn", "Storlek", "Antal", "Pris (kr)", "Summa (kr)"];
  const lines = [...rows.values()].map((row) =>
    [
      row.kategori ?? "öl",
      row.artikelnummer ?? "",
      row.gtin ?? "",
      row.namn,
      row.storlek ?? (row.volymMl ? `${row.volymMl / 10} cl` : ""),
      row.antal,
      money(row.prisKr),
      row.prisKr == null ? "" : money(row.antal * row.prisKr),
    ].join(";"),
  );
  return [header.join(";"), ...lines].join("\r\n");
}
