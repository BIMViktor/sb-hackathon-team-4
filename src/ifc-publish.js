/**
 * Publicerar IFC-filen med ölburkar och snusdosor i StreamBIM.
 *
 * Flödet följer jonatanjacobsson/streambim-api-docs:
 *  1. POST /v2/upload-tickets                  → s3presignedurl  (attachments.md)
 *  2. PUT  s3presignedurl med fetch              (verifierat från widget, annotations-custom-objects.md)
 *  3a. Första gången: POST /v2/documents         i vald mapp     (documents.md)
 *  3b. Därefter:      POST /v2/document-revisions → ny revision av samma dokument
 *  4. Första gången: POST /v2/ifc-files          kopplar dokumentet till byggnaden i ett lager (ifc-files.md)
 *  5. POST /cmv3/converter-jobs                  startar konvertering (converter-jobs.md)
 *
 * VERIFY:
 *  - Steg 4 och 5 kräver projektadmin enligt docs.
 *  - /cmv3/converter-jobs (GET) misslyckades från widget i docs-svepet 2026-11-01
 *    (rest-api-from-widgets.md). POST är inte testad. Misslyckas den måste
 *    konverteringen startas i StreamBIM:s byggnadsvy.
 *  - En konvertering gäller hela byggnaden, inte bara den här filen.
 *  - Om IFC-filens koordinater landar rätt mot byggnaden. Byggnadens koordinater
 *    används rakt av, med en justerbar förskjutning i inställningarna.
 *  - Vilka lagernamn som är tillåtna. Vi föreslår lager som redan finns i byggnaden.
 */

const parse = (text) => {
  const json = typeof text === "string" ? JSON.parse(text) : text;
  return json?.data ?? json;
};

export function describeApiError(error) {
  const text = error?.message ?? error?.code ?? String(error);
  if (/DataCloneError|could not be cloned/i.test(text)) {
    return "StreamBIM nekade anropet (svaret går inte att läsa från widgeten). Vanligaste orsakerna: saknad behörighet (projektadmin krävs) eller fel adress.";
  }
  return text;
}

/** Lokal konfiguration per projekt: dokument-id, ifc-file-id, mapp, lager, revision, förskjutning. */
export function publishConfig(projectId) {
  const key = `ifc-publish:${projectId}`;
  let config = {};
  try {
    config = JSON.parse(localStorage.getItem(key) ?? "{}");
  } catch {
    config = {};
  }
  return {
    get: () => ({ auto: true, offset: { x: 0, y: 0, z: 0 }, ...config }),
    set(patch) {
      config = { ...config, ...patch };
      try {
        localStorage.setItem(key, JSON.stringify(config));
      } catch {
        /* Gäller bara sessionen om lagring är blockerad. */
      }
      return this.get();
    },
  };
}

async function base(client) {
  const [projectId, buildingId] = await Promise.all([client.getProjectId(), client.getBuildingId()]);
  return { projectId, buildingId: String(buildingId), v2: `/project-${projectId}/api/v1/v2` };
}

/** Mappar som användaren kan ladda upp i. */
export async function listFolders(client) {
  const { v2 } = await base(client);
  const data = parse(await client.makeApiRequest({ url: `${v2}/folders` }));
  return (Array.isArray(data) ? data : [])
    .map((folder) => ({ id: String(folder.id), name: folder.attributes?.path || folder.attributes?.name || `Mapp ${folder.id}` }))
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));
}

/** Lager som redan används i byggnaden (från ifc-files). */
export async function listLayers(client) {
  const { v2, buildingId } = await base(client);
  const data = parse(await client.makeApiRequest({ url: `${v2}/ifc-files?filter[building]=${buildingId}` }));
  const layers = new Set();
  for (const file of Array.isArray(data) ? data : []) {
    for (const layer of String(file.attributes?.layer ?? "").split("~")) if (layer) layers.add(layer);
  }
  return [...layers].sort();
}

/**
 * Laddar upp IFC-texten och kopplar den till byggnaden.
 * onStep(id, status, text) rapporterar varje steg: status = "run" | "ok" | "fail" | "skip".
 * @returns {Promise<{ documentId, revision, ifcFileId, converterStarted: boolean }>}
 */
export async function publishIfc(client, { text, fileName, folderId, layer, config, onStep = () => {} }) {
  const { projectId, buildingId, v2 } = await base(client);
  const blob = new Blob([text], { type: "application/octet-stream" });
  const size = blob.size;
  const current = config.get();
  const step = async (id, label, fn) => {
    onStep(id, "run", label);
    try {
      const result = await fn();
      onStep(id, "ok", label);
      return result;
    } catch (error) {
      onStep(id, "fail", `${label}: ${describeApiError(error)}`);
      throw error;
    }
  };

  // 1–2. Uppladdning till S3.
  const ticket = await step("ticket", "Uppladdningsbiljett", async () =>
    parse(
      await client.makeApiRequest({
        url: `${v2}/upload-tickets`,
        method: "POST",
        body: { data: { id: "0", type: "attachments", attributes: { filename: fileName, "file-size": size } } },
      }),
    ),
  );
  await step("s3", `Laddar upp ${fileName} (${Math.round(size / 1024)} kB)`, async () => {
    const url = ticket?.attributes?.s3presignedurl;
    if (!url) throw new Error("Biljetten saknar s3presignedurl.");
    if (url.startsWith("mock:")) return; // mock-läge
    const response = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: blob });
    if (!response.ok) throw new Error(`S3 svarade ${response.status}.`);
  });

  // 3. Dokument eller ny revision.
  let documentId = current.documentId;
  let revision = current.revision ?? 1;
  if (!documentId) {
    const document = await step("document", "Skapar dokument", async () =>
      parse(
        await client.makeApiRequest({
          url: `${v2}/documents`,
          method: "POST",
          body: {
            data: {
              id: "0",
              type: "documents",
              attributes: { filename: fileName, filesize: size, description: "Ölburkar och snusdosor från widgeten (team 4)" },
              relationships: {
                labels: { data: [] },
                parent: { data: { id: String(folderId), type: "folders" } },
                "upload-ticket": { data: { type: "upload-tickets", id: ticket.id } },
              },
            },
          },
        }),
      ),
    );
    documentId = String(document.id);
    revision = 1;
    config.set({ documentId, revision, folderId: String(folderId) });
  } else {
    // VERIFY: om revisionsnumret ska läsas från dokumentet. Vi frågar först, och räknar annars lokalt.
    try {
      const doc = parse(await client.makeApiRequest({ url: `${v2}/documents/${documentId}` }));
      const latest = Number(doc?.attributes?.revision ?? doc?.attributes?.["revision-number"]);
      if (Number.isFinite(latest) && latest >= revision) revision = latest;
    } catch {
      /* Räknar vidare lokalt. */
    }
    const nextRevision = revision + 1;
    await step("document", `Ny revision ${nextRevision} av dokument ${documentId}`, async () =>
      client.makeApiRequest({
        url: `${v2}/document-revisions`,
        method: "POST",
        body: {
          data: {
            id: `${documentId}-${nextRevision}`,
            type: "document-revisions",
            attributes: { description: `Uppdaterad ${new Date().toLocaleString("sv-SE")}`, filesize: size },
            relationships: { "upload-ticket": { data: { type: "upload-tickets", id: ticket.id } } },
          },
        },
      }),
    );
    revision = nextRevision;
    config.set({ revision });
  }

  // 4. Koppla till byggnaden (en gång).
  let ifcFileId = config.get().ifcFileId;
  if (!ifcFileId) {
    const file = await step("ifc-file", `Kopplar till byggnaden i lager ${layer}`, async () =>
      parse(
        await client.makeApiRequest({
          url: `${v2}/ifc-files`,
          method: "POST",
          body: {
            data: {
              type: "ifc-files",
              attributes: { layer, "marked-for-deletion": false },
              relationships: {
                document: { data: { type: "documents", id: documentId } },
                building: { data: { type: "buildings", id: buildingId } },
              },
            },
          },
        }),
      ),
    );
    ifcFileId = String(file?.id ?? `${buildingId}-${documentId}`);
    config.set({ ifcFileId, layer });
  } else {
    onStep("ifc-file", "skip", `Redan kopplad till byggnaden (${ifcFileId}, lager ${config.get().layer ?? layer})`);
  }

  // 5. Konvertering. Väntat fel från widget, se VERIFY ovan.
  let converterStarted = false;
  try {
    await step("convert", "Startar konvertering", async () =>
      client.makeApiRequest({
        url: "/cmv3/converter-jobs",
        method: "POST",
        body: {
          data: {
            type: "converter-jobs",
            attributes: { "floorplan-layer": config.get().floorplanLayer || layer, name: `Öl & snus ${new Date().toLocaleString("sv-SE")}`, persist: false },
            relationships: {
              building: { data: { type: "buildings", id: buildingId } },
              project: { data: { type: "projects", id: String(projectId) } },
            },
          },
        },
      }),
    );
    converterStarted = true;
  } catch {
    onStep("convert", "fail", "Konverteringen gick inte att starta från widgeten. Starta den i StreamBIM: byggnaden → modellfiler → Konvertera.");
  }

  config.set({ publishedAt: new Date().toISOString() });
  return { documentId, revision, ifcFileId, converterStarted };
}
