import path from "node:path";
import { createRequire } from "node:module";
import { wrapPlanningPdfJsColourNormalization } from "./planning-pdf-colour-normalizer.mjs";

let runtimePromise = null;

export async function loadPlanningPdfJsRuntime() {
  if (!runtimePromise) runtimePromise = createRuntime();
  return runtimePromise;
}

async function createRuntime() {
  const module = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const require = createRequire(import.meta.url);
  const packageRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const standardFontDataUrl = `${path.join(packageRoot, "standard_fonts")}${path.sep}`;
  const cMapUrl = `${path.join(packageRoot, "cmaps")}${path.sep}`;
  const runtime = {
    OPS: module.OPS,
    version: module.version || null,
    packageRoot,
    standardFontDataUrl,
    cMapUrl,
    getDocument(options = {}) {
      return module.getDocument({
        ...options,
        standardFontDataUrl: options.standardFontDataUrl || standardFontDataUrl,
        cMapUrl: options.cMapUrl || cMapUrl,
        cMapPacked: options.cMapPacked ?? true
      });
    }
  };
  return wrapPlanningPdfJsColourNormalization(runtime);
}
