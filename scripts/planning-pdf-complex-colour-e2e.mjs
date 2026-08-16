#!/usr/bin/env node
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { sha256 } from "../src/lib/io.mjs";
import { processPlanningExtractionShard } from "../src/lib/planning-extraction-worker.mjs";
import { loadPlanningPdfJsRuntime } from "../src/lib/planning-pdfjs-runtime.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "voxel-planning-complex-colour-e2e-"));
try {
  const bytes = buildComplexColourEvidencePdf();
  const source = bytes.toString("latin1");
  assert.match(source, /\[\/Separation\s+\/SpotRed\s+\/DeviceRGB/, "fixture must contain a real Separation colour space");
  assert.match(source, /\[\/DeviceN\s+\[\/InkA\s+\/InkB\]\s+\/DeviceRGB/, "fixture must contain a real DeviceN colour space");
  assert.match(source, /\[\/ICCBased\s+11\s+0\s+R\]/, "fixture must contain a real ICCBased colour space");

  const pdfEngine = await loadPlanningPdfJsRuntime();
  const loadingTask = pdfEngine.getDocument({ data: new Uint8Array(bytes) });
  const document = await loadingTask.promise;
  const page = await document.getPage(1);
  const operatorList = await page.getOperatorList();
  const normalization = operatorList.planningColourNormalization;

  assert.equal(normalization?.outputColourSpace, "srgb-8bit");
  assert.equal(normalization?.failClosedForComplexColourSpaces, true);
  assert.equal(operatorList.fnArray.includes(pdfEngine.OPS.setFillColorSpace), false, "resolved complex colour-space declarations must not leak downstream");
  assert.equal(operatorList.fnArray.includes(pdfEngine.OPS.setFillColorN), false, "resolved Separation/DeviceN values must become RGB before Voxel Mapper extraction");
  assert.equal(operatorList.fnArray.includes(pdfEngine.OPS.setFillColor), false, "resolved ICCBased values must become RGB before Voxel Mapper extraction");
  assert.ok(normalization?.rgbCanonicalized >= 6, "expected PDF.js-resolved complex colours to be canonicalized at the runtime boundary");

  const rgbFills = operatorList.fnArray.flatMap((fn, index) =>
    fn === pdfEngine.OPS.setFillRGBColor ? [operatorList.argsArray[index]] : []
  );
  assert.ok(hasRgb(rgbFills, [255, 0, 0], 2), "expected Separation tint transform to produce red RGB");
  assert.ok(hasRgb(rgbFills, [51, 102, 153], 3), "expected DeviceN tint transform to produce its alternate RGB result");
  assert.ok(hasRgb(rgbFills, [20, 20, 20], 2), "expected ICCBased alternate DeviceRGB values to reach RGB output");
  await document.destroy?.();

  const contentHash = sha256(bytes);
  const objectDir = path.join(root, "planning-documents", "objects");
  await mkdir(objectDir, { recursive: true });
  const objectPath = `objects/${contentHash}.pdf`;
  await writeFile(path.join(root, "planning-documents", objectPath), bytes);

  const manifest = await processPlanningExtractionShard({
    extractionQueue: [{
      contentHash,
      objectPath,
      contentType: "application/pdf",
      classification: "site_plan",
      applicationKeys: ["complex-colour-e2e:1"],
      priority: 100,
      shard: 0
    }]
  }, {
    cacheDir: root,
    shardIndex: 0,
    concurrency: 1,
    pdfEngine,
    strictPlanningExtraction: true
  });

  assert.equal(manifest.extractedDocuments, 1);
  assert.equal(manifest.failedDocuments, 0);
  assert.equal(manifest.rasterOnlyDocuments, 0);
  assert.ok(manifest.legendEntries >= 3, "expected Separation, DeviceN and ICCBased legend entries");

  const extraction = manifest.results[0]?.extraction;
  assert.equal(extraction?.status, "extracted");
  assert.equal(extraction?.normalizedEvidence?.worldGeometryReady, false);
  assert.equal(extraction?.normalizedEvidence?.georegistrationStatus, "required");
  assert.ok(extraction?.normalizedEvidence?.legendResolution?.acceptedEntryCount >= 3);

  const materials = extraction.normalizedEvidence.materialObservations || [];
  const separationFill = findDerivedMaterial(materials, "red_tarmac");
  const deviceNFill = findDerivedMaterial(materials, "resin_bound_grey");
  const iccFill = findDerivedMaterial(materials, "fresh_black_asphalt");

  assert.ok(separationFill, "expected Separation legend swatch to propagate red_tarmac onto drawing geometry");
  assert.ok(deviceNFill, "expected DeviceN legend swatch to propagate resin_bound_grey onto drawing geometry");
  assert.ok(iccFill, "expected ICCBased legend swatch to propagate fresh_black_asphalt onto drawing geometry");

  for (const evidence of [separationFill, deviceNFill, iccFill]) {
    assert.equal(evidence.source, "pdf-legend-fill-material");
    assert.equal(evidence.georegistrationRequired, true);
    assert.equal(evidence.legendEvidence?.terrainGeometryMutable, false);
    assert.ok(Number(evidence.xPt) > 200, "derived evidence must land on map geometry, not the legend key");
  }

  const entries = extraction.normalizedEvidence.legendEntries || [];
  for (const material of ["red_tarmac", "resin_bound_grey", "fresh_black_asphalt"]) {
    const entry = entries.find((candidate) => candidate.material === material && candidate.fillAccepted);
    assert.ok(entry?.fillStyleKey, `expected ${material} complex-space swatch to resolve to a canonical RGB fill key`);
  }

  console.log(JSON.stringify({
    pdfJsVersion: pdfEngine.version,
    status: extraction.status,
    sourceColourSpaces: {
      separation: true,
      deviceN: true,
      iccBased: true
    },
    runtimeColourNormalization: normalization,
    vectorPaths: extraction.pages?.[0]?.vector?.pathCount || 0,
    legendEntries: extraction.normalizedEvidence.legendEntries.length,
    acceptedLegendEntries: extraction.normalizedEvidence.legendResolution.acceptedEntryCount,
    materialObservations: materials.length,
    resolvedMaterials: {
      separation: separationFill.material,
      deviceN: deviceNFill.material,
      iccBased: iccFill.material
    },
    terrainGeometryMutable: false,
    worldGeometryReady: extraction.normalizedEvidence.worldGeometryReady
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}

function findDerivedMaterial(materials, material) {
  return materials.find((entry) =>
    entry.material === material &&
    entry.source === "pdf-legend-fill-material" &&
    Number(entry.xPt) > 200
  );
}

function hasRgb(values, expected, tolerance = 0) {
  return values.some((value) => Array.isArray(value) && expected.every((component, index) =>
    Math.abs(Number(value[index]) - component) <= tolerance
  ));
}

function buildComplexColourEvidencePdf() {
  const content = [
    "0.5 w",
    "BT /F1 11 Tf 20 300 Td (As-Built Complex Material Plan Scale 1:100) Tj ET",

    // Separation/spot colour. The Type 2 tint function maps tint=1 to red.
    "/SpotRed cs",
    "1 scn",
    "20 238 24 16 re f",
    "BT /F1 10 Tf 55 243 Td (Red tarmac) Tj ET",
    "/SpotRed cs",
    "1 scn",
    "230 226 130 36 re f",

    // DeviceN with two named inks. The sampled tint transform intentionally
    // maps every tint combination to the same deterministic RGB value so the
    // fixture tests parsing/alternate-space conversion without interpolation
    // ambiguity.
    "/TwoInk cs",
    "0.25 0.75 scn",
    "20 165 24 16 re f",
    "BT /F1 10 Tf 55 170 Td (Resin bound grey) Tj ET",
    "/TwoInk cs",
    "0.25 0.75 scn",
    "230 153 130 36 re f",

    // ICCBased with an explicit DeviceRGB alternate. PDF.js 4.10.38 resolves
    // this through the alternate space before exposing the operator list.
    "/ICC cs",
    "0.08 0.08 0.08 sc",
    "20 92 24 16 re f",
    "BT /F1 10 Tf 55 97 Td (Fresh black asphalt) Tj ET",
    "/ICC cs",
    "0.08 0.08 0.08 sc",
    "230 80 130 36 re f",
    ""
  ].join("\n");

  const sampledHex = "336699336699336699336699>";
  const sampledFunction = [
    `<< /FunctionType 0 /Domain [0 1 0 1] /Range [0 1 0 1 0 1] /Size [2 2] /BitsPerSample 8 /Order 1 /Encode [0 1 0 1] /Decode [0 1 0 1 0 1] /Filter /ASCIIHexDecode /Length ${Buffer.byteLength(sampledHex)} >>`,
    "stream",
    sampledHex,
    "endstream"
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 325] /Resources << /Font << /F1 5 0 R >> /ColorSpace << /SpotRed 6 0 R /TwoInk 7 0 R /ICC 8 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "[/Separation /SpotRed /DeviceRGB 9 0 R]",
    "[/DeviceN [/InkA /InkB] /DeviceRGB 10 0 R]",
    "[/ICCBased 11 0 R]",
    "<< /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [1 0 0] /N 1 >>",
    sampledFunction,
    "<< /N 3 /Alternate /DeviceRGB /Length 0 >>\nstream\nendstream"
  ];

  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n`;
  output += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "binary");
}
