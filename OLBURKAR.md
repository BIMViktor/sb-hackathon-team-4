# Ölburks-widget (prototyp)

Ställ ut ölburkar från Systembolagets katalog i StreamBIM-modellen. Varje burk blir ett eget objekt med property setet **Systembolaget**: artikelnummer, varunummer, GTIN, namn, producent, volym, alkoholhalt, pris och länk till produktsidan.

## Så används den

1. Sök och välj en öl i katalogen.
2. Välj objekttyp:
   - **Burk som zon** (standard): en burkstor cylinder (24-hörnig kontur, ⌀ 66 mm, 115 mm hög för 33 cl och 168 mm för 50 cl) som står på ytan du klickar på. Det kan tas bort. Det ritas i 3D först när byggnaden har bearbetats om, men syns direkt i objektinformationen.
   - **Burk som punkt**: en annotation via `createObject`. Den syns direkt, men **StreamBIM kan inte radera annotationer**. Använd den sparsamt i sandlådan.
3. Tryck **Ställ ut vid klick** och klicka på en yta i modellen. Varje klick ställer ut en burk tills du trycker igen.
4. **Visa burkar i ölens färg** färgar alla zon-burkar med ölens färg via `colorCodeSpaces` och tonar ned resten av modellen. Nya burkar färgas direkt om läget är på. **Släck färger** återställer. Färgen syns på burkar som redan ritas i 3D, alltså efter ombearbetning.
5. **Utställda burkar** listar det du ställt ut i projektet (sparas i webbläsaren). **Exportera CSV** ger antal per artikelnummer och GTIN med summa.

På localhost (`npm run dev -- --port 3000`) körs allt mot mock-data. Klicka på proverna under *Simulera* för att ställa ut.

## Katalog, artikelnummer och GTIN

Katalogen finns i `src/catalog.js`.

- **Artikelnummer** ("Nr") är kontrollerade mot systembolaget.se 2026-11-05. De två sista siffrorna är förpackningskoden, resten är varunumret.
- **GTIN**: Systembolaget publicerar inte GTIN öppet. Produkt-API:t stängdes 2020 och produktsidorna visar inget GTIN. De GTIN som finns i katalogen kommer från Open Food Facts och är matchade på varumärke, volym, alkoholhalt och burk:
  - Nr 141212 Norrlands Guld Export 50 cl → 7310401006758
  - Nr 144712 Bright Brew 50 cl → 7310401006963
- Övriga artiklar har `gtin: null`. Skanna eller läs av streckkoden på burken och fyll i GTIN i widgeten. Kontrollsiffran valideras och värdet sparas lokalt. Lägg in det i `catalog.js` för att det ska gälla alla.
- Kontrollera GTIN mot burken eller leverantören innan data används skarpt.

## Teknik

| Fil | Roll |
| --- | --- |
| `src/main.js` | Gränssnitt, katalogsök, klick → utställning, lista, CSV |
| `src/beer.js` | Placering: koordinatbyte, zon/annotation, property set, radering, register |
| `src/catalog.js` | Katalog, burkmått, GTIN-kontroll |
| `src/streambim.js` | Kopplingen. Utökad med `getBuildingId`, `createObject` och `makeApiRequest` (live och mock) |

- Klickpunkten från `pickedObject` är i vyns axlar `[x, -z, y]`. Den räknas om till byggnadens `[x, y, z]` innan zonen skapas.
- Zonen skapas med `POST /project-{id}/api/v1/v2/ifc-objects` via `makeApiRequest`, samma anrop som StreamBIM:s **Lägg till zon**. Våningen hämtas från det klickade objektet, annars från `getFloors()` (högsta våning under punkten).
- Annotationen skapas med `createObject` och får sedan property setet med en full-record `PATCH`.
- Artikelnummer och GTIN sparas som text så att inga siffror tappas (StreamBIM lagrar tal som `float8`).
- Ett anrop per klick, ingen loop över modellen.

## Kända begränsningar

- Nya zoner ritas inte i 3D och hittas inte på egenskaper med sök förrän byggnaden bearbetats om.
- Annotationer går inte att radera (DELETE svarar 200 men objektet ligger kvar).
- `makeApiRequest` kan rapportera lyckade skrivningar som `DataCloneError`. Widgeten varnar då i stället för att räkna det som fel.
- Listan över utställda burkar ligger i webbläsarens lagring. En annan användare ser burkarna i modellen men inte i listan.

Källor: [streambim-widget-api](https://github.com/streambim/streambim-widget-api), [streambim-api-docs](https://github.com/jonatanjacobsson/streambim-api-docs) (`widget/guides/annotations-custom-objects.md`, `widget/methods/createObject.md`, `widget/methods/getFloors.md`).

## Fota burken (OCR och streckkod)

Överst i panelen finns **Ta bild / välj fil**. På mobilen öppnas kameran, på datorn väljer du en bildfil.

1. **Streckkod:** om webbläsaren har `BarcodeDetector` (Chrome/Edge på Android, macOS och ChromeOS) läses EAN-13 direkt. En träff på GTIN i katalogen väljs automatiskt.
2. **OCR:** annars läses texten med Tesseract.js (svenska och engelska). Motorn laddas från jsdelivr först när den behövs, så det blir inget nytt npm-paket. Första gången laddas cirka 5–10 MB språkdata.
3. **Matchning:** texten jämförs fuzzy med namn och producent, och alkoholhalt (t.ex. "5,3 %") och volym ("50 cl") ger plus eller minus. GTIN eller artikelnummer i texten ger direktträff. Upp till tre förslag visas med träffsäkerhet. Du bekräftar genom att välja ett.
4. Läses en streckkod som inte finns i katalogen och du väljer en öl utan GTIN, sparas streckkoden som GTIN för den ölen.

Logiken ligger i `src/ocr.js`. Begränsningar: matchningen går bara mot katalogen i `src/catalog.js`, inte mot hela Systembolagets sortiment (Systembolaget har inget öppet produkt-API). Text på böjda burkar och stiliserade typsnitt läses ibland fel. Fota rakt mot namnet eller streckkoden.

## Flikar: Rum och Arbetsmiljö

Widgeten har tre flikar: **Ölburkar**, **Rum** och **Arbetsmiljö**. Rum och Arbetsmiljö kommer från `team4-rum-och-arbetsmiljo.patch` (Rumskollen och Riskkollen) och ligger oförändrade i `src/room-colors.js` och `src/risk-check.js`.

- **Rum:** färgsätter rum per grupp (t.ex. areatyp), area eller datakvalitet, med förklaring, våningsfilter och rumslista.
- **Arbetsmiljö:** riskscan per kategori och våning, riskregister med klick i modellen (sparas i webbläsaren) och CSV-export.
- Klick i modellen ställer bara ut burkar när fliken Ölburkar är aktiv. Rum följer alltid klick och våningsbyten, och Arbetsmiljö tar emot klick när den fliken är aktiv.
- Både Rum och "Visa burkar i ölens färg" använder `colorCodeSpaces`. Den som anropas sist gäller.
- Stilen för båda flikarna har fått Dalux-färgerna.
