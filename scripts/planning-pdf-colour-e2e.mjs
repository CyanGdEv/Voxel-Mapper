#!/usr/bin/env node
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { sha256 } from "../src/lib/io.mjs";
import { processPlanningExtractionShard } from "../src/lib/planning-extraction-worker.mjs";
import { loadPlanningPdfJsRuntime } from "../src/lib/planning-pdfjs-runtime.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "voxel-planning-colour-e2e-"));
try {
  const bytes = buildColourEvidencePdf();
  const source = bytes.toString("latin1");
  assert.match(source, /0 1 1 0 k/, "fixture must contain a real DeviceCMYK fill operator");
  assert.match(source, /0\.6 g/, "fixture must contain a real DeviceGray fill operator");
  assert.match(source, /0\.4 G/, "fixture must contain a real DeviceGray stroke operator for hatch evidence");

  const pdfEngine = await loadPlanningPdfJsRuntime();
  const loadingTask = pdfEngine.getDocument({ data: new Uint8Array(bytes) });
  const document = await loadingTask.promise;
  const page = await document.getPage(1);
  const operatorList = await page.getOperatorList();
  const colourNormalization = operatorList.planningColourNormalization;
  assert.equal(colourNormalization?.outputColourSpace, "srgb-8bit");
  assert.equal(colourNormalization?.failClosedForComplexColourSpaces, true);
  assert.equal(operatorList.fnArray.includes(pdfEngine.OPS.setFillCMYKColor), false, "CMYK must not leak past the runtime boundary");
  assert.equal(operatorList.fnArray.includes(pdfEngine.OPS.setFillGray), false, "Gray fill must not leak past the runtime boundary");
  assert.equal(operatorList.fnArray.includes(pdfEngine.OPS.setStrokeGray), false, "Gray stroke must not leak past the runtime boundary");
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
      applicationKeys: ["colour-e2e:1"],
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
  assert.ok(manifest.legendEntries >= 3, "expected CMYK fill, Gray fill and Gray hatch legend entries");

  const extraction = manifest.results[0]?.extraction;
  assert.equal(extraction?.status, "extracted");
  assert.equal(extraction?.normalizedEvidence?.worldGeometryReady, false);
  assert.equal(extraction?.normalizedEvidence?.georegistrationStatus, "required");
  assert.ok(extraction?.normalizedEvidence?.legendResolution?.acceptedEntryCount >= 3);

  const materials = extraction.normalizedEvidence.materialObservations || [];
  const cmykFill = findDerivedMaterial(materials, "red_tarmac", "pdf-legend-fill-material");
  const grayFill = findDerivedMaterial(materials, "old_concrete", "pdf-legend-fill-material");
  const grayHatch = findDerivedMaterial(materials, "resin_bound_grey", "pdf-legend-hatch-material");

  assert.ok(cmykFill, "expected a real CMYK legend swatch to propagate red_tarmac onto drawing geometry");
  assert.ok(grayFill, "expected a real grayscale legend swatch to propagate old_concrete onto drawing geometry");
  assert.ok(grayHatch, "expected real grayscale hatch strokes to propagate resin_bound_grey onto drawing geometry");

  for (const evidence of [cmykFill, grayFill, grayHatch]) {
    assert.equal(evidence.georegistrationRequired, true);
    assert.equal(evidence.legendEvidence?.terrainGeometryMutable, false);
    assert.ok(Number(evidence.xPt) > 180, "derived evidence should land on the map geometry, not the legend key");
  }

  const entries = extraction.normalizedEvidence.legendEntries || [];
  const redLegend = entries.find((entry) => entry.material === "red_tarmac" && entry.fillAccepted);
  const concreteLegend = entries.find((entry) => entry.material === "old_concrete" && entry.fillAccepted);
  const hatchLegend = entries.find((entry) => entry.material === "resin_bound_grey" && entry.hatchAccepted);
  assert.ok(redLegend?.fillStyleKey, "expected CMYK swatch to resolve to a canonical RGB fill key");
  assert.ok(concreteLegend?.fillStyleKey, "expected Gray swatch to resolve to a canonical RGB fill key");
  assert.ok(hatchLegend?.hatchStyleKey, "expected Gray hatch to resolve to a canonical RGB hatch key");

  console.log(JSON.stringify({
    pdfJsVersion: pdfEngine.version,
    status: extraction.status,
    sourceColourOperators: {
      deviceCmykFill: true,
      deviceGrayFill: true,
      deviceGrayStroke: true
    },
    runtimeColourNormalization: colourNormalization,
    vectorPaths: extraction.pages?.[0]?.vector?.pathCount || 0,
    legendEntries: extraction.normalizedEvidence.legendEntries.length,
    acceptedLegendEntries: extraction.normalizedEvidence.legendResolution.acceptedEntryCount,
    materialObservations: materials.length,
    resolvedMaterials: {
      cmykFill: cmykFill.material,
      grayFill: grayFill.material,
      grayHatch: grayHatch.material
    },
    terrainGeometryMutable: false,
    worldGeometryReady: extraction.normalizedEvidence.worldGeometryReady
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}

function findDerivedMaterial(materials, material, source) {
  return materials.find((entry) => entry.material === material && entry.source === source && Number(entry.xPt) > 180);
}

function buildColourEvidencePdf() {
  const content = [
    "0.5 w",
    "BT /F1 11 Tf 20 255 Td (As-Built Material Plan Scale 1:100) Tj ET",

    // P1: a true DeviceCMYK red swatch and a larger map polygon using the
    // same CMYK values. PDF.js must convert both before legend resolution.
    "0 1 1 0 k",
    "20 197 22 16 re f",
    "BT /F1 10 Tf 50 202 Td (P1) Tj ET",
    "BT /F1 10 Tf 80 202 Td (Red tarmac) Tj ET",
    "0 1 1 0 k",
    "220 174 120 45 re f",

    // P2: DeviceGray solid fill used both in the legend and map geometry.
    "0.6 g",
    "20 137 22 16 re f",
    "BT /F1 10 Tf 50 142 Td (P2) Tj ET",
    "BT /F1 10 Tf 80 142 Td (Old concrete) Tj ET",
    "0.6 g",
    "220 111 120 42 re f",

    // P3: a closed legend key containing a repeated DeviceGray hatch. The
    // larger outlined map polygon repeats the same hatch signature.
    "0 G",
    "20 72 26 22 re S",
    "0.4 G",
    "0.5 w",
    "22 76 m 43 84 l S",
    "22 81 m 43 89 l S",
    "22 86 m 43 94 l S",
    "BT /F1 10 Tf 52 82 Td (P3) Tj ET",
    "BT /F1 10 Tf 80 82 Td (Resin bound grey) Tj ET",
    "0 G",
    "220 35 120 50 re S",
    "0.4 G",
    "0.5 w",
    "225 42 m 260 55.333 l S",
    "245 42 m 280 55.333 l S",
    "265 42 m 300 55.333 l S",
    "285 42 m 320 55.333 l S",
    "",
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 280] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
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
