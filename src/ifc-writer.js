/**
 * Skriver en IFC2X3-fil (STEP, ISO 10303-21) med utställda ölburkar och snusdosor.
 *
 * Varje produkt blir ett IfcBuildingElementProxy med:
 *  - geometri av staplade cylindrar (IfcExtrudedAreaSolid + IfcCircleProfileDef):
 *    burk = fot, kropp, axel, hals och kant; dosa = botten och lock.
 *  - färg (IfcStyledItem + IfcSurfaceStyleShading) i produktens färg.
 *  - property set "Systembolaget" eller "Snus" med artikelnummer, GTIN m.m.
 *  - placering i byggnadens koordinater (meter), i en IfcBuildingStorey med
 *    samma namn och nivå som våningen i StreamBIM.
 *
 * IFC2X3 valdes för att det är det format som flest konverterare läser.
 * Ingen extern dependency: filen är text och byggs här.
 */

const IFC_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

/** Ny IFC GlobalId (22 tecken, 128 bitar). */
export function newGuid(random = cryptoRandom) {
  const bytes = random(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // UUID v4
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let num = 0n;
  for (const b of bytes) num = (num << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 22; i += 1) {
    out = IFC_CHARS[Number(num & 63n)] + out;
    num >>= 6n;
  }
  return out;
}

function cryptoRandom(n) {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** STEP-sträng: ' dubbleras, \ dubbleras, tecken utanför ASCII blir \X2\hhhh\X0\. */
export function str(value) {
  if (value == null || value === "") return "$";
  let out = "";
  let wide = "";
  const flush = () => {
    if (wide) out += `\\X2\\${wide}\\X0\\`;
    wide = "";
  };
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    if (code >= 32 && code <= 126) {
      flush();
      out += ch === "'" ? "''" : ch === "\\" ? "\\\\" : ch;
    } else if (code > 0xffff) {
      flush();
      out += "?";
    } else {
      wide += code.toString(16).toUpperCase().padStart(4, "0");
    }
  }
  flush();
  return `'${out}'`;
}

/** STEP-tal: alltid med decimalpunkt. */
export function real(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0.";
  const rounded = Math.round(n * 1e6) / 1e6;
  const text = String(rounded);
  if (text.includes("e")) {
    const [mantissa, exponent] = text.split("e");
    return `${mantissa.includes(".") ? mantissa : `${mantissa}.`}E${exponent}`;
  }
  return text.includes(".") ? text : `${text}.`;
}

const ref = (id) => `#${id}`;
const list = (items) => `(${items.join(",")})`;

/** Burkens profil nerifrån: [höjd, radie] i meter. Summan av höjderna = totalhöjd. */
export function canProfile(height, diameter) {
  const r = diameter / 2;
  if (height < 0.05) {
    // Snusdosa: botten och ett lock som är något större.
    const lid = Math.min(0.006, height * 0.3);
    return [
      [height - lid, r - 0.0008],
      [lid, r],
    ];
  }
  const foot = 0.006;
  const shoulder = 0.008;
  const neck = 0.004;
  const rim = 0.002;
  const body = height - foot - shoulder - neck - rim;
  return [
    [foot, r * 0.86],
    [body, r],
    [shoulder, r * 0.93],
    [neck, r * 0.84],
    [rim, r * 0.8],
  ];
}

function hexToRgb(hex) {
  const h = String(hex || "888888").replace("#", "").padEnd(6, "0");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

/**
 * @param {object} opts
 * @param {Array<{guid, name, description, objectType, tag, center:[x,y,z], height, diameter, color, floorName, psetName, props:[key,value][]}>} opts.items
 * @param {Array<{name, elevation}>} opts.floors   Våningar från getFloors (namn och nivå i meter).
 * @param {object} [opts.offset]  {x, y, z} som läggs på alla positioner (kalibrering).
 * @param {string} [opts.projectName]
 * @param {string} [opts.author]
 * @param {string} [opts.fileName]
 * @param {() => string} [opts.guid]  GUID-generator (för tester).
 * @param {Date} [opts.now]
 */
export function writeIfc({ items, floors = [], offset = {}, projectName = "StreamBIM", author = "", fileName = "ol-och-snus.ifc", guid = newGuid, now = new Date() }) {
  const lines = [];
  let next = 1;
  const add = (entity) => {
    const id = next;
    next += 1;
    lines.push(`#${id}=${entity};`);
    return id;
  };

  const dx = Number(offset.x) || 0;
  const dy = Number(offset.y) || 0;
  const dz = Number(offset.z) || 0;
  const stamp = Math.floor(now.getTime() / 1000);

  // Ägare och applikation (krävs i IFC2X3).
  const person = add(`IFCPERSON($,${str(author || "Widget")},$,$,$,$,$,$)`);
  const org = add(`IFCORGANIZATION($,${str("Team 4, StreamBIM hackathon")},$,$,$)`);
  const personOrg = add(`IFCPERSONANDORGANIZATION(${ref(person)},${ref(org)},$)`);
  const app = add(`IFCAPPLICATION(${ref(org)},'1.0',${str("Öl & snus-widget")},'sb-hackathon-team-4')`);
  const owner = add(`IFCOWNERHISTORY(${ref(personOrg)},${ref(app)},$,.ADDED.,$,$,$,${stamp})`);

  // Geometrisk kontext och enheter.
  const origin = add("IFCCARTESIANPOINT((0.,0.,0.))");
  const zAxis = add("IFCDIRECTION((0.,0.,1.))");
  const xAxis = add("IFCDIRECTION((1.,0.,0.))");
  const world = add(`IFCAXIS2PLACEMENT3D(${ref(origin)},${ref(zAxis)},${ref(xAxis)})`);
  const context = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${ref(world)},$)`);
  const units = [
    add("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)"),
    add("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)"),
    add("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)"),
    add("IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)"),
  ];
  const unitAssignment = add(`IFCUNITASSIGNMENT(${list(units.map(ref))})`);
  const project = add(`IFCPROJECT(${str(guid())},${ref(owner)},${str(projectName)},${str("Utställda ölburkar och snusdosor")},$,$,$,(${ref(context)}),${ref(unitAssignment)})`);

  // Platsstruktur: Site → Building → Storeys. Alla placeringar i origo, så att
  // produkternas koordinater blir byggnadens koordinater.
  const sitePlacement = add(`IFCLOCALPLACEMENT($,${ref(world)})`);
  const site = add(`IFCSITE(${str(guid())},${ref(owner)},'Site',$,$,${ref(sitePlacement)},$,$,.ELEMENT.,$,$,$,$,$)`);
  const buildingPlacement = add(`IFCLOCALPLACEMENT(${ref(sitePlacement)},${ref(world)})`);
  const building = add(`IFCBUILDING(${str(guid())},${ref(owner)},${str("Öl & snus")},$,$,${ref(buildingPlacement)},$,$,.ELEMENT.,$,$,$)`);
  add(`IFCRELAGGREGATES(${str(guid())},${ref(owner)},$,$,${ref(project)},(${ref(site)}))`);
  add(`IFCRELAGGREGATES(${str(guid())},${ref(owner)},$,$,${ref(site)},(${ref(building)}))`);

  // Våningar: de som används av produkterna, med nivå från StreamBIM.
  const usedFloors = [...new Set(items.map((item) => item.floorName || "Okänd våning"))];
  const storeyIds = new Map();
  const storeyPlacementIds = new Map();
  for (const name of usedFloors) {
    const floor = floors.find((f) => f.name === name);
    const elevation = Number(floor?.elevation ?? floor?.height ?? 0);
    const placement = add(`IFCLOCALPLACEMENT(${ref(buildingPlacement)},${ref(world)})`);
    const storey = add(`IFCBUILDINGSTOREY(${str(guid())},${ref(owner)},${str(name)},$,$,${ref(placement)},$,$,.ELEMENT.,${real(elevation + dz)})`);
    storeyIds.set(name, storey);
    storeyPlacementIds.set(name, placement);
  }
  if (storeyIds.size) {
    add(`IFCRELAGGREGATES(${str(guid())},${ref(owner)},$,$,${ref(building)},${list([...storeyIds.values()].map(ref))})`);
  }

  // Delade stilar per färg.
  const styles = new Map();
  const styleFor = (hex) => {
    if (styles.has(hex)) return styles.get(hex);
    const [r, g, b] = hexToRgb(hex);
    const colour = add(`IFCCOLOURRGB($,${real(r)},${real(g)},${real(b)})`);
    const shading = add(`IFCSURFACESTYLESHADING(${ref(colour)})`);
    const surface = add(`IFCSURFACESTYLE(${str(`#${hex}`)},.BOTH.,(${ref(shading)}))`);
    const assignment = add(`IFCPRESENTATIONSTYLEASSIGNMENT((${ref(surface)}))`);
    styles.set(hex, assignment);
    return assignment;
  };

  const contained = new Map(usedFloors.map((name) => [name, []]));
  const profileOrigin = add("IFCCARTESIANPOINT((0.,0.))");
  const profilePlacement = add(`IFCAXIS2PLACEMENT2D(${ref(profileOrigin)},$)`);

  for (const item of items) {
    const [x, y, z] = item.center;
    const floorName = item.floorName || "Okänd våning";
    const point = add(`IFCCARTESIANPOINT((${real(x + dx)},${real(y + dy)},${real(z + dz)}))`);
    const axes = add(`IFCAXIS2PLACEMENT3D(${ref(point)},${ref(zAxis)},${ref(xAxis)})`);
    const placement = add(`IFCLOCALPLACEMENT(${ref(storeyPlacementIds.get(floorName))},${ref(axes)})`);

    const style = styleFor(item.color);
    const solids = [];
    let level = 0;
    for (const [segmentHeight, radius] of canProfile(item.height, item.diameter)) {
      const circle = add(`IFCCIRCLEPROFILEDEF(.AREA.,$,${ref(profilePlacement)},${real(radius)})`);
      const base = add(`IFCCARTESIANPOINT((0.,0.,${real(level)}))`);
      const position = add(`IFCAXIS2PLACEMENT3D(${ref(base)},${ref(zAxis)},${ref(xAxis)})`);
      const solid = add(`IFCEXTRUDEDAREASOLID(${ref(circle)},${ref(position)},${ref(zAxis)},${real(segmentHeight)})`);
      add(`IFCSTYLEDITEM(${ref(solid)},(${ref(style)}),$)`);
      solids.push(solid);
      level += segmentHeight;
    }
    const shape = add(`IFCSHAPEREPRESENTATION(${ref(context)},'Body','SweptSolid',${list(solids.map(ref))})`);
    const definition = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${ref(shape)}))`);
    const element = add(
      `IFCBUILDINGELEMENTPROXY(${str(item.guid)},${ref(owner)},${str(item.name)},${str(item.description)},${str(item.objectType)},${ref(placement)},${ref(definition)},${str(item.tag)},.ELEMENT.)`,
    );
    contained.get(floorName).push(element);

    const props = item.props
      .filter(([, value]) => value != null && value !== "")
      .map(([key, value]) =>
        add(
          `IFCPROPERTYSINGLEVALUE(${str(key)},$,${typeof value === "number" ? `IFCREAL(${real(value)})` : `IFCLABEL(${str(value)})`},$)`,
        ),
      );
    if (props.length) {
      const pset = add(`IFCPROPERTYSET(${str(guid())},${ref(owner)},${str(item.psetName)},$,${list(props.map(ref))})`);
      add(`IFCRELDEFINESBYPROPERTIES(${str(guid())},${ref(owner)},$,$,(${ref(element)}),${ref(pset)})`);
    }
  }

  for (const [name, elements] of contained) {
    if (!elements.length) continue;
    add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${str(guid())},${ref(owner)},$,$,${list(elements.map(ref))},${ref(storeyIds.get(name))})`);
  }

  const iso = now.toISOString().slice(0, 19);
  const header = [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('ViewDefinition [CoordinationView_V2.0]'),'2;1');",
    `FILE_NAME(${str(fileName)},'${iso}',(${str(author || "Widget")}),(${str("Team 4")}),'sb-hackathon-team-4','sb-hackathon-team-4','');`,
    "FILE_SCHEMA(('IFC2X3'));",
    "ENDSEC;",
    "DATA;",
  ];
  return [...header, ...lines, "ENDSEC;", "END-ISO-10303-21;", ""].join("\n");
}
