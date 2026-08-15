#!/usr/bin/env node
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { sha256 } from "../src/lib/io.mjs";
import { loadPlanningPdfJsRuntime } from "../src/lib/planning-pdfjs-runtime.mjs";
import { enrichPlanningTextEvidence } from "../src/lib/planning-text-evidence.mjs";
import { extractPlanningDocument } from "../src/lib/planning-vector-extractor.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "voxel-planning-pdfjs-"));
try {
  const bytes = buildPdf();
  const contentHash = sha256(bytes);
  const objectDir = path.join(root, "planning-documents", "objects");
  await mkdir(objectDir, { recursive: true });
  const objectPath = `objects/${contentHash}.pdf`;
  await writeFile(path.join(root, "planning-documents", objectPath), bytes);
  const pdfEngine = await loadPlanningPdfJsRuntime();
  const extraction = await extractPlanningDocument({
    contentHash,
    objectPath,
    contentType: "application/pdf",
    classification: "site_plan",
    applicationKeys: ["smoke:1"],
    priority: 100,
    shard: 0
  }, { cacheDir: root, pdfEngine });
  enrichPlanningTextEvidence(extraction);

  console.log(JSON.stringify({
    pdfJsVersion: pdfEngine.version,
    positionedText: extraction.pages[0]?.text?.items || [],
    materialEvidence: extraction.normalizedEvidence?.materialObservations || []
  }, null, 2));

  assert.equal(extraction.status, "extracted");
  assert.equal(extraction.pageCount, 1);
  assert.ok(extraction.pages[0].vector.pathCount >= 1, "expected vector rectangle from real PDF.js operator list");
  assert.ok(extraction.normalizedEvidence.geometryCandidates.length >= 1, "expected geometry candidate");
  assert.equal(extraction.normalizedEvidence.worldGeometryReady, false);
  assert.equal(extraction.pages[0].metadata?.scaleDenominator, 100);
  assert.ok(extraction.normalizedEvidence.verticalObservations.some((entry) => entry.valueM === 12.5));
  assert.ok(extraction.normalizedEvidence.materialObservations.some((entry) => entry.material === "red_tarmac"));
  assert.ok(extraction.normalizedEvidence.materialObservations.some((entry) => entry.source === "pdf-text-adjacent-run-material-label"));
  console.log(JSON.stringify({
    status: extraction.status,
    textItems: extraction.pages[0].text.itemCount,
    vectorPaths: extraction.pages[0].vector.pathCount,
    geometryCandidates: extraction.normalizedEvidence.geometryCandidates.length,
    scale: extraction.pages[0].metadata?.scaleDenominator,
    verticalObservations: extraction.normalizedEvidence.verticalObservations.length,
    materialObservations: extraction.normalizedEvidence.materialObservations.length,
    splitRunMaterialRecovered: true
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}

function buildPdf() {
  const content = [
    "0.5 w",
    "10 20 100 50 re S",
    "BT /F1 12 Tf 20 170 Td (Proposed Site Plan Scale 1:100 FFL 12.50) Tj ET",
    "BT /F1 12 Tf 20 145 Td (Red) Tj ET",
    "BT /F1 12 Tf 43 145 Td (tarmac) Tj ET",
    ""
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 220] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
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
