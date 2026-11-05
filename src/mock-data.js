/** Fake project used when the widget is opened outside StreamBIM. */

export const project = {
  id: "hackathon-sandbox",
  name: "Hackathon Sandbox",
  userEmail: "team@hackathon.local",
};

export const floors = [
  { id: "floor-1", name: "Plan 1", elevation: 0 },
  { id: "floor-2", name: "Plan 2", elevation: 3.2 },
  { id: "floor-3", name: "Plan 3", elevation: 6.4 },
];

export const objects = [
  {
    guid: "MOCK-DOOR-101",
    name: "Dörr 101",
    type: "IfcDoor",
    floorId: "floor-1",
    point: [4.2, 1.1, 0.9],
    props: { Type: "IfcDoor", Name: "Dörr 101", IsExternal: "True" },
  },
  {
    guid: "MOCK-WALL-A",
    name: "Vägg A",
    type: "IfcWall",
    floorId: "floor-1",
    point: [2, 1.4, 0],
    props: { Type: "IfcWall", Name: "Vägg A", IsExternal: "True" },
  },
  {
    guid: "MOCK-WINDOW-12",
    name: "Fönster 12",
    type: "IfcWindow",
    floorId: "floor-2",
    point: [6.5, 4.6, 1.2],
    props: { Type: "IfcWindow", Name: "Fönster 12", IsExternal: "True" },
  },
  {
    guid: "MOCK-SPACE-201",
    name: "Rum 201",
    type: "IfcSpace",
    floorId: "floor-2",
    point: [8, 4.8, 1.5],
    props: { "@kind": "Space", Type: "IfcSpace", Name: "201", "Long Name": "Mötesrum", "BaseQuantities~NetFloorArea": 22.4, "Areatyp (SS 21054)": "LOA", Rumsfunktion: "Mötesrum" },
  },
];

/**
 * Extra rooms (IfcSpace) for the room colouring feature in mock mode.
 * Some values are left empty on purpose so the data quality view has something to show.
 */
const ROOM_TYPES = [
  ["Kontor", "LOA", 12], ["Mötesrum", "LOA", 24], ["Kontorslandskap", "LOA", 86], ["Pentry", "LOA", 16],
  ["WC", "BIA", 4.5], ["Städ", "BIA", 5.5], ["Teknikrum", "BIA", 18], ["Förråd", "BIA", 9],
  ["Korridor", "ÖVA", 34], ["Trapphus", "ÖVA", 16],
];
const GAPS = { 3: "Areatyp (SS 21054)", 8: "Long Name", 13: "BaseQuantities~NetFloorArea", 17: "Areatyp (SS 21054)", 21: "Rumsfunktion", 22: "Areatyp (SS 21054)" };

floors.forEach((floor, f) => {
  for (let i = 0; i < 8; i++) {
    if (f === 1 && i === 0) continue; // Rum 201 finns redan ovan
    const n = f * 8 + i;
    const [fn, areaType, base] = ROOM_TYPES[(n * 7 + f) % ROOM_TYPES.length];
    const area = Math.round(base * (0.85 + ((n * 37) % 30) / 100) * 10) / 10;
    const nr = `${f + 1}${String(i + 1).padStart(2, "0")}`;
    const props = {
      "@kind": "Space",
      Type: "IfcSpace",
      Name: nr,
      "Long Name": fn,
      "BaseQuantities~NetFloorArea": area,
      "Areatyp (SS 21054)": areaType,
      Rumsfunktion: fn,
      Brandcell: `BC${f + 1}-${i < 4 ? 1 : 2}`,
    };
    if (GAPS[n]) delete props[GAPS[n]];
    objects.push({
      guid: `MOCK-ROOM-${nr}`,
      name: `Rum ${nr}`,
      type: "IfcSpace",
      floorId: floor.id,
      point: [i * 4, f * 3.2 + 1.5, 2],
      props,
    });
  }
});

/** Building parts for the Arbetsmiljö (risk scan) feature in mock mode. */
const RISK_PARTS = [
  ["Opening element", "Öppning bjälklag", 2], ["Stair flight", "Trapplopp", 3], ["Ramp", "Ramp entré", 1],
  ["Roof", "Yttertak", 1], ["Beam", "Stålbalk HEA300", 3], ["Column", "Betongpelare", 3], ["Transport element", "Hiss", 1],
];
floors.forEach((floor, f) => {
  RISK_PARTS.forEach(([kind, label, perFloor]) => {
    if (kind === "Roof" && f !== floors.length - 1) return;
    if (kind === "Ramp" && f !== 0) return;
    for (let i = 1; i <= perFloor; i++) {
      const name = `${label} ${f + 1}.${i}`;
      objects.push({
        guid: `MOCK-RISK-${kind.replace(/\s/g, "")}-${f + 1}-${i}`,
        name,
        type: kind,
        floorId: floor.id,
        point: [i * 3, f * 3.2 + 1, 4],
        props: { "@kind": kind, Type: kind, Name: name },
      });
    }
  });
});
