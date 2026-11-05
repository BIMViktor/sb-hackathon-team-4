/**
 * Namnsättning av rum (fliken Rum).
 *
 * - Visningsmall: hur ett rum visas i listor och i mock-planen, t.ex.
 *   "{Name} {Long Name}" eller "{Våning}: {Name} – {Rumsfunktion}".
 * - Manuella ändringar: nytt rumsnummer (Name) och rumsnamn (Long Name) per rum.
 * - Omnumrering: ett mönster som "{plan}{nr}" ger nya nummer per våning.
 *
 * Ändringarna sparas i webbläsaren per projekt (localStorage) och ändrar inte
 * IFC-modellen. Rummen i modellen kommer från arkitektens IFC och skrivs över
 * vid nästa uppladdning, så rätt väg tillbaka är namnlistan (CSV) som förs in
 * i projekteringsverktyget.
 */

export const NAME = "Name";
export const LONG = "Long Name";
export const DEFAULT_TEMPLATE = "{Name} {Long Name}";

/** Fyller en mall med rummets egenskaper. {Våning} ger våningens namn. */
export function formatName(template, room) {
  const text = String(template || DEFAULT_TEMPLATE).replace(/\{([^}]+)\}/g, (_, key) => {
    const k = key.trim();
    if (/^(våning|vaning|floor)$/i.test(k)) return room.floor ?? "";
    const value = room.props?.[k];
    return value == null ? "" : String(value);
  });
  const clean = text.replace(/\s+/g, " ").replace(/^[\s\-–:,·]+|[\s\-–:,·]+$/g, "").trim();
  return clean || room.props?.[NAME] || room.guid;
}

/** Lägger på sparade ändringar ovanpå originalvärdena. */
export function applyOverride(room, override) {
  room.orig ??= { [NAME]: room.props[NAME] ?? "", [LONG]: room.props[LONG] ?? "" };
  room.props[NAME] = override?.[NAME] ?? room.orig[NAME];
  room.props[LONG] = override?.[LONG] ?? room.orig[LONG];
  room.name = room.props[NAME] || room.guid;
  room.longName = room.props[LONG] || "";
  room.changed = Boolean(override && (NAME in override || LONG in override));
  return room;
}

/** Sparar bara fält som skiljer sig från originalet. Tomt objekt = inget ändrat. */
export function makeOverride(room, { name, longName }) {
  const out = {};
  if (name != null && name !== room.orig[NAME]) out[NAME] = name;
  if (longName != null && longName !== room.orig[LONG]) out[LONG] = longName;
  return out;
}

/**
 * Föreslår nya rumsnummer.
 * pattern: {plan} = våningens ordning (1, 2 …), {våning} = våningens namn, {nr} = löpnummer.
 * Numreringen börjar om på varje våning.
 */
export function renumber(rooms, { pattern = "{plan}{nr}", digits = 2, start = 1, step = 1, order = "name", floorOrder = [] } = {}) {
  const byFloor = new Map();
  for (const room of rooms) {
    if (!byFloor.has(room.floor)) byFloor.set(room.floor, []);
    byFloor.get(room.floor).push(room);
  }
  const floorIndex = (floor) => {
    const i = floorOrder.indexOf(floor);
    return i === -1 ? floorOrder.length + [...byFloor.keys()].indexOf(floor) + 1 : i + 1;
  };
  const key = (room) => (order === "longname" ? `${room.longName} ${room.name}` : String(room.orig?.[NAME] ?? room.name));
  const result = new Map();
  for (const [floor, list] of byFloor) {
    const sorted = [...list].sort((a, b) => key(a).localeCompare(key(b), "sv", { numeric: true }));
    sorted.forEach((room, i) => {
      const nr = String(start + i * step).padStart(digits, "0");
      const name = pattern
        .replace(/\{plan\}/gi, String(floorIndex(floor)))
        .replace(/\{v[åa]ning\}/gi, floor ?? "")
        .replace(/\{nr\}/gi, nr);
      result.set(room.guid, name);
    });
  }
  return result;
}

/** Hittar rumsnummer som förekommer mer än en gång. */
export function duplicates(rooms) {
  const seen = new Map();
  for (const room of rooms) {
    const name = String(room.name ?? "").trim();
    if (!name) continue;
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([name]) => name));
}

/** Namnlista för projektören (semikolon, svensk Excel). */
export function namesCsv(rooms) {
  const cell = (v) => {
    const s = String(v ?? "");
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["GUID", "Våning", "Rumsnummer (original)", "Rumsnummer (nytt)", "Rumsnamn (original)", "Rumsnamn (nytt)", "Ändrat"];
  const lines = rooms.map((r) =>
    [r.guid, r.floor, r.orig?.[NAME], r.name, r.orig?.[LONG], r.longName, r.changed ? "ja" : ""].map(cell).join(";"),
  );
  return [header.join(";"), ...lines].join("\r\n");
}

/** Lokal lagring per projekt. */
export function namingStore(projectId) {
  const key = `rc-names:${projectId}`;
  const tplKey = `rc-template:${projectId}`;
  const read = (k, fallback) => {
    try {
      const raw = localStorage.getItem(k);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  };
  const write = (k, value) => {
    try {
      localStorage.setItem(k, JSON.stringify(value));
    } catch {
      /* Gäller bara sessionen om lagring är blockerad. */
    }
  };
  return {
    overrides: () => read(key, {}),
    saveOverrides: (map) => write(key, map),
    template: () => read(tplKey, DEFAULT_TEMPLATE),
    saveTemplate: (tpl) => write(tplKey, tpl),
  };
}
