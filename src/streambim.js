/**
 * StreamBIM connection for the hackathon starter.
 *
 * Live (inside StreamBIM):
 *   streambim-widget-api.min.js talks to the parent viewer with Penpal,
 *   which is postMessage under the hood. After connectToParent(), call
 *   StreamBIM.API — do not invent a second command protocol.
 *
 * Mock (localhost, or any top-level window):
 *   The same client methods return fake BIM data. Simulator buttons post
 *   a local message so the listener path is the one you can extend.
 *
 * Safe methods on the returned client:
 *   getProjectId, getUserEmail, getFloors, getObjectInfo, findObjects,
 *   highlightObject, deHighlightAllObjects, gotoObject, gotoFloor,
 *   colorCodeObjects
 * Added for the beer-can widget (live + mock):
 *   getBuildingId, createObject, makeApiRequest, colorCodeSpaces, zoomToSearchResult
 * Live only: client.api is the full StreamBIM.API. It is null in mock mode.
 * colorCodeObjects takes hex colors WITHOUT a leading #.
 * Do not log tokens, and do not call setAuthToken.
 */

import { floors, objects, project } from "./mock-data.js";

const INCOMING = "streambim-hackathon";
const OUTGOING = "streambim-widget";
const CONNECT_TIMEOUT_MS = 8000;

export function isEmbedded() {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/** Custom widget → parent message. StreamBIM ignores unknown types; viewer commands go through the client. */
export function sendToParent(type, payload) {
  const message = { source: OUTGOING, type, payload };
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(message, "*");
  }
  return message;
}

/**
 * @param {object} handlers
 * @param {(result: { guid?: string, name?: string, point?: number[] }) => void} [handlers.onPickedObject]
 * @param {(floorId: string) => void} [handlers.onFloorChanged]
 * @param {(guids: string[]) => void} [handlers.onSpacesChanged]
 * @param {(state: object) => void} [handlers.onCameraChanged]
 */
export async function connectWidget(handlers = {}) {
  if (isEmbedded()) {
    if (!window.StreamBIM?.connectToParent) {
      return failedClient("Widget-API-skriptet laddade inte.");
    }
    const live = await connectLive(handlers);
    if (live) return live;
    return failedClient("Kunde inte ansluta till StreamBIM inom 8 sekunder.");
  }
  return connectMock(handlers);
}

function connectLive(handlers) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), CONNECT_TIMEOUT_MS);

    try {
      window.StreamBIM
        .connectToParent(window.parent, {
          pickedObject: (result) => handlers.onPickedObject?.(result ?? {}),
          floorChanged: (floorId) => handlers.onFloorChanged?.(String(floorId ?? "")),
          spacesChanged: (guids) => handlers.onSpacesChanged?.(Array.isArray(guids) ? guids : []),
          cameraChanged: (state) => handlers.onCameraChanged?.(state ?? {}),
        })
        .then(() => {
          const api = window.StreamBIM.API;
          finish(api ? wrapLive(api) : null);
        })
        .catch(() => finish(null));
    } catch {
      finish(null);
    }
  });
}

function wrapLive(api) {
  return {
    mode: "live",
    reason: "",
    api,
    simulate: null,
    getProjectId: () => api.getProjectId(),
    getUserEmail: () => api.getUserEmail(),
    getFloors: () => api.getFloors(),
    getObjectInfo: (guid) => api.getObjectInfo(guid),
    findObjects: (query) => api.findObjects(query),
    highlightObject: (guid) => api.highlightObject(guid),
    deHighlightAllObjects: () => api.deHighlightAllObjects(),
    gotoObject: (guid) => api.gotoObject(guid),
    gotoFloor: (floorId) => api.gotoFloor(floorId),
    colorCodeObjects: (map) => api.colorCodeObjects(map),
    // Ölburks-widgeten: placering av egna objekt.
    getBuildingId: () => api.getBuildingId(),
    createObject: (opts) => api.createObject(opts),
    makeApiRequest: (request) => api.makeApiRequest(request),
    colorCodeSpaces: (map) => api.colorCodeSpaces(withHash(map)),
    zoomToSearchResult: () => api.zoomToSearchResult(),
  };
}

/** StreamBIM:s colorCodeSpaces vill ha "#rrggbb". Rumskollen skickar hex utan #. */
function withHash(map) {
  const out = {};
  for (const [guid, hex] of Object.entries(map ?? {})) {
    out[guid] = String(hex).startsWith("#") ? String(hex) : `#${hex}`;
  }
  return out;
}

function connectMock(handlers) {
  const onMessage = (event) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== INCOMING) return;
    if (data.type === "pickedObject") handlers.onPickedObject?.(data.payload ?? {});
    if (data.type === "floorChanged") handlers.onFloorChanged?.(String(data.payload ?? ""));
    if (data.type === "spacesChanged") {
      handlers.onSpacesChanged?.(Array.isArray(data.payload) ? data.payload : []);
    }
    if (data.type === "cameraChanged") handlers.onCameraChanged?.(data.payload ?? {});
  };
  window.addEventListener("message", onMessage);

  const emit = (type, payload) => {
    window.postMessage({ source: INCOMING, type, payload }, window.location.origin);
  };

  return {
    mode: "mock",
    reason: "",
    api: null,
    simulate: {
      pick(guid) {
        const object = objects.find((item) => item.guid === guid) ?? objects[0];
        emit("pickedObject", { guid: object.guid, name: object.name, point: object.point });
      },
      floor(floorId) {
        emit("floorChanged", floorId);
      },
      camera() {
        emit("cameraChanged", { position: [12.5, 8.2, 14], target: [4, 1.2, 0], up: [0, 1, 0] });
      },
    },
    async getProjectId() {
      return project.id;
    },
    async getUserEmail() {
      return project.userEmail;
    },
    async getFloors() {
      return floors.map((floor) => ({ ...floor }));
    },
    async getObjectInfo(guid) {
      const object = objects.find((item) => item.guid === guid);
      if (!object) throw new Error(`Hittade inte ${guid} i mock-modellen.`);
      const floor = floors.find((item) => item.id === object.floorId);
      return {
        guid: object.guid,
        name: object.name,
        type: object.type,
        floor: floor?.name ?? object.floorId,
        props: { ...object.props },
      };
    },
    async findObjects(query) {
      const key = String(query?.key ?? "").toLowerCase();
      const value = String(query?.value ?? "").toLowerCase();
      const limit = Number(query?.limit ?? 20);
      return objects
        .filter((object) => matchesQuery(object, key, value))
        .slice(0, limit)
        .map((object) => object.guid);
    },
    async highlightObject(guid) {
      requireObject(guid);
      return { highlighted: guid };
    },
    async deHighlightAllObjects() {
      return { cleared: true };
    },
    async gotoObject(guid) {
      const object = requireObject(guid);
      return { goto: object.guid, point: object.point };
    },
    async gotoFloor(floorId) {
      const floor = floors.find((item) => item.id === floorId);
      if (!floor) throw new Error(`Hittade inte våning ${floorId}.`);
      return { floorId: floor.id, name: floor.name };
    },
    async colorCodeObjects(map) {
      if (!map || typeof map !== "object") throw new Error("colorCodeObjects vill ha en map av guid → hex.");
      return { colored: { ...map } };
    },
    async getBuildingId() {
      return mockRest.buildingId;
    },
    async createObject({ center, name }) {
      // Samma axelbyte som StreamBIM: vy [a, b, c] → byggnad [a, c, -b].
      const [a, b, c] = center;
      const record = mockRest.store({
        type: "ifc-objects",
        attributes: { layer: null, properties: { Name: name, "@kind": "Annotation" }, groups: [], center: [a, c, -b] },
        relationships: { floors: { data: [{ type: "floors", id: floors[0].id }] } },
      });
      return record.id;
    },
    async makeApiRequest(request) {
      return mockRest.handle(request);
    },
    async colorCodeSpaces(map) {
      if (!map || typeof map !== "object") throw new Error("colorCodeSpaces vill ha en map av guid → #rrggbb.");
      return true;
    },
    async zoomToSearchResult() {
      return true;
    },
  };
}

/** Minimal in-memory /v2/ifc-objects för mock-läget. */
const mockRest = {
  buildingId: "mock-building",
  records: new Map(),
  counter: 0,
  store(data) {
    this.counter += 1;
    const id = `MOCK-OBJ-${String(this.counter).padStart(4, "0")}`;
    const record = { ...data, id };
    this.records.set(id, record);
    return record;
  },
  async handle({ url = "", method = "GET", body } = {}) {
    const verb = method.toUpperCase();
    const match = url.match(/\/v2\/ifc-objects(?:\/([^?]+))?/);
    if (!match) throw { code: "notFound", debug: `Mock saknar ${verb} ${url}` };
    const id = match[1] ? decodeURIComponent(match[1]) : null;
    if (verb === "POST" && !id) {
      return JSON.stringify({ data: this.store(body.data) });
    }
    if (verb === "GET" && id) {
      const known = this.records.get(id);
      if (known) return JSON.stringify({ data: known });
      const object = objects.find((item) => item.guid === id);
      if (!object) throw { code: "notFound", debug: id };
      return JSON.stringify({
        data: {
          id,
          type: "ifc-objects",
          attributes: { properties: { Name: object.name }, groups: [], center: object.point },
          relationships: { floors: { data: [{ type: "floors", id: object.floorId }] } },
        },
      });
    }
    if (verb === "PATCH" && id && this.records.has(id)) {
      const record = { ...this.records.get(id), ...body.data, id };
      this.records.set(id, record);
      return JSON.stringify({ data: record });
    }
    if (verb === "DELETE" && id) {
      this.records.delete(id);
      return JSON.stringify({ data: null });
    }
    throw { code: "notFound", debug: `Mock saknar ${verb} ${url}` };
  },
};

function failedClient(reason) {
  const fail = async () => {
    throw new Error(reason);
  };
  return {
    mode: "error",
    reason,
    api: null,
    simulate: null,
    getProjectId: fail,
    getUserEmail: fail,
    getFloors: fail,
    getObjectInfo: fail,
    findObjects: fail,
    highlightObject: fail,
    deHighlightAllObjects: fail,
    gotoObject: fail,
    gotoFloor: fail,
    colorCodeObjects: fail,
    getBuildingId: fail,
    createObject: fail,
    makeApiRequest: fail,
    colorCodeSpaces: fail,
    zoomToSearchResult: fail,
  };
}

function requireObject(guid) {
  const object = objects.find((item) => item.guid === guid);
  if (!object) throw new Error(`Hittade inte ${guid} i mock-modellen.`);
  return object;
}

function matchesQuery(object, key, value) {
  if (!value) return true;
  if (!key || key === "type" || key === "ifcclass") {
    return object.type.toLowerCase().includes(value);
  }
  if (key === "name") return object.name.toLowerCase().includes(value);
  return String(propValue(object, key) ?? "").toLowerCase().includes(value);
}

function propValue(object, key) {
  if (object.props[key] != null) return object.props[key];
  const match = Object.keys(object.props).find((name) => name.toLowerCase() === key);
  return match ? object.props[match] : undefined;
}
