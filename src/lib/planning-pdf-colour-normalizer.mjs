const DEVICE_GRAY = "device-gray";
const DEVICE_RGB = "device-rgb";
const DEVICE_CMYK = "device-cmyk";

/**
 * Canonicalizes any residual planning-PDF colour operators into the RGB
 * operators already consumed by planning-vector-extractor.mjs.
 *
 * PDF.js currently performs this conversion itself for its normal evaluator
 * path. This layer is deliberately idempotent: it is a defensive boundary for
 * raw/synthetic operator lists, alternate PDF engines and future runtime
 * changes. Pattern/spot/DeviceN colour spaces are never guessed.
 */
export function normalizePlanningPdfOperatorListColours(operatorList = {}, OPS = {}) {
  const fnArray = arrayCopy(operatorList.fnArray);
  const argsArray = arrayCopy(operatorList.argsArray).map(cloneOperatorArgs);
  let strokeSpace = null;
  let fillSpace = null;
  const counts = {
    grayToRgb: 0,
    cmykToRgb: 0,
    genericDeviceToRgb: 0,
    rgbCanonicalized: 0,
    unsupportedColourOperators: 0
  };

  for (let index = 0; index < fnArray.length; index += 1) {
    const fn = fnArray[index];
    const args = argsArray[index];

    if (opEquals(fn, OPS.setStrokeColorSpace)) {
      strokeSpace = normalizeDeviceColourSpace(args?.[0]);
      continue;
    }
    if (opEquals(fn, OPS.setFillColorSpace)) {
      fillSpace = normalizeDeviceColourSpace(args?.[0]);
      continue;
    }

    if (opEquals(fn, OPS.setStrokeGray)) {
      if (replaceWithRgb(fnArray, argsArray, index, OPS.setStrokeRGBColor, grayToRgb(args))) counts.grayToRgb += 1;
      continue;
    }
    if (opEquals(fn, OPS.setFillGray)) {
      if (replaceWithRgb(fnArray, argsArray, index, OPS.setFillRGBColor, grayToRgb(args))) counts.grayToRgb += 1;
      continue;
    }
    if (opEquals(fn, OPS.setStrokeCMYKColor)) {
      if (replaceWithRgb(fnArray, argsArray, index, OPS.setStrokeRGBColor, cmykToRgb(args))) counts.cmykToRgb += 1;
      continue;
    }
    if (opEquals(fn, OPS.setFillCMYKColor)) {
      if (replaceWithRgb(fnArray, argsArray, index, OPS.setFillRGBColor, cmykToRgb(args))) counts.cmykToRgb += 1;
      continue;
    }
    if (opEquals(fn, OPS.setStrokeRGBColor)) {
      const rgb = rgbToBytes(args);
      if (rgb) { argsArray[index] = rgb; counts.rgbCanonicalized += 1; }
      strokeSpace = DEVICE_RGB;
      continue;
    }
    if (opEquals(fn, OPS.setFillRGBColor)) {
      const rgb = rgbToBytes(args);
      if (rgb) { argsArray[index] = rgb; counts.rgbCanonicalized += 1; }
      fillSpace = DEVICE_RGB;
      continue;
    }

    if (opEquals(fn, OPS.setStrokeColor)) {
      const rgb = deviceComponentsToRgb(strokeSpace, args);
      if (rgb && replaceWithRgb(fnArray, argsArray, index, OPS.setStrokeRGBColor, rgb)) counts.genericDeviceToRgb += 1;
      else counts.unsupportedColourOperators += 1;
      continue;
    }
    if (opEquals(fn, OPS.setFillColor)) {
      const rgb = deviceComponentsToRgb(fillSpace, args);
      if (rgb && replaceWithRgb(fnArray, argsArray, index, OPS.setFillRGBColor, rgb)) counts.genericDeviceToRgb += 1;
      else counts.unsupportedColourOperators += 1;
      continue;
    }

    // ColorN may represent Pattern, Separation, DeviceN or ICCBased data. Only
    // convert it when an explicit simple Device* space was observed. Otherwise
    // preserve the operator and fail closed rather than manufacturing a colour.
    if (opEquals(fn, OPS.setStrokeColorN)) {
      const rgb = deviceComponentsToRgb(strokeSpace, args);
      if (rgb && replaceWithRgb(fnArray, argsArray, index, OPS.setStrokeRGBColor, rgb)) counts.genericDeviceToRgb += 1;
      else counts.unsupportedColourOperators += 1;
      continue;
    }
    if (opEquals(fn, OPS.setFillColorN)) {
      const rgb = deviceComponentsToRgb(fillSpace, args);
      if (rgb && replaceWithRgb(fnArray, argsArray, index, OPS.setFillRGBColor, rgb)) counts.genericDeviceToRgb += 1;
      else counts.unsupportedColourOperators += 1;
    }
  }

  const converted = counts.grayToRgb + counts.cmykToRgb + counts.genericDeviceToRgb;
  return {
    ...operatorList,
    fnArray,
    argsArray,
    planningColourNormalization: {
      schemaVersion: 1,
      status: converted || counts.rgbCanonicalized ? "canonicalized" : "unchanged",
      outputColourSpace: "srgb-8bit",
      failClosedForComplexColourSpaces: true,
      convertedOperators: converted,
      ...counts
    }
  };
}

/**
 * Wraps a PDF.js-like engine without changing its external loading-task,
 * document or page contracts. Only getOperatorList() is intercepted.
 */
export function wrapPlanningPdfJsColourNormalization(engine) {
  if (!engine?.getDocument || !engine?.OPS) return engine;
  return new Proxy(engine, {
    get(target, property) {
      if (property === "getDocument") {
        return (...args) => wrapLoadingTask(target.getDocument(...args), target.OPS);
      }
      return boundProperty(target, property);
    }
  });
}

export function grayToRgb(args) {
  const values = numericComponents(args);
  if (values.length < 1) return null;
  const byte = unitToByte(values[0]);
  return [byte, byte, byte];
}

export function cmykToRgb(args) {
  const values = numericComponents(args);
  if (values.length < 4) return null;
  const [c, m, y, k] = values.slice(0, 4).map(componentToUnit);
  return [
    byte255((1 - c) * (1 - k) * 255),
    byte255((1 - m) * (1 - k) * 255),
    byte255((1 - y) * (1 - k) * 255)
  ];
}

export function normalizeDeviceColourSpace(value) {
  const raw = colourSpaceName(value);
  if (!raw) return null;
  const normalized = raw.replace(/^\//, "").replace(/[\s_-]+/g, "").toLowerCase();
  if (["devicegray", "gray", "grey", "g", "calgray"].includes(normalized)) return DEVICE_GRAY;
  if (["devicergb", "rgb", "calrgb"].includes(normalized)) return DEVICE_RGB;
  if (["devicecmyk", "cmyk"].includes(normalized)) return DEVICE_CMYK;
  return null;
}

function wrapLoadingTask(task, OPS) {
  if (!task || typeof task !== "object") return Promise.resolve(task).then((document) => wrapDocument(document, OPS));
  const sourcePromise = task.promise ? Promise.resolve(task.promise) : Promise.resolve(task);
  const wrappedPromise = sourcePromise.then((document) => wrapDocument(document, OPS));
  return new Proxy(task, {
    get(target, property) {
      if (property === "promise") return wrappedPromise;
      return boundProperty(target, property);
    }
  });
}

function wrapDocument(document, OPS) {
  if (!document || typeof document !== "object" || typeof document.getPage !== "function") return document;
  return new Proxy(document, {
    get(target, property) {
      if (property === "getPage") {
        return async (...args) => wrapPage(await target.getPage(...args), OPS);
      }
      return boundProperty(target, property);
    }
  });
}

function wrapPage(page, OPS) {
  if (!page || typeof page !== "object" || typeof page.getOperatorList !== "function") return page;
  return new Proxy(page, {
    get(target, property) {
      if (property === "getOperatorList") {
        return async (...args) => normalizePlanningPdfOperatorListColours(await target.getOperatorList(...args), OPS);
      }
      return boundProperty(target, property);
    }
  });
}

function deviceComponentsToRgb(space, args) {
  if (space === DEVICE_GRAY) return grayToRgb(args);
  if (space === DEVICE_RGB) return rgbToBytes(args);
  if (space === DEVICE_CMYK) return cmykToRgb(args);
  return null;
}

function rgbToBytes(args) {
  const values = numericComponents(args);
  if (values.length < 3) return null;
  return values.slice(0, 3).map(unitToByte);
}

function replaceWithRgb(fnArray, argsArray, index, rgbOp, rgb) {
  if (!Number.isFinite(Number(rgbOp)) || !Array.isArray(rgb) || rgb.length !== 3) return false;
  fnArray[index] = rgbOp;
  argsArray[index] = rgb;
  return true;
}

function colourSpaceName(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.name === "string") return value.name;
  return null;
}

function numericComponents(args) {
  const values = Array.isArray(args) || ArrayBuffer.isView(args) ? [...args] : [];
  return values.map(Number).filter(Number.isFinite);
}

function componentToUnit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  if (number > 1) return Math.max(0, Math.min(1, number / 255));
  return Math.max(0, Math.min(1, number));
}

function unitToByte(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return number > 1 ? byte255(number) : byte255(number * 255);
}

function byte255(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}

function cloneOperatorArgs(value) {
  if (Array.isArray(value)) return [...value];
  if (ArrayBuffer.isView(value)) return [...value];
  return value;
}

function arrayCopy(value) {
  if (Array.isArray(value)) return [...value];
  if (ArrayBuffer.isView(value)) return [...value];
  return [];
}

function opEquals(value, expected) {
  return expected != null && value === expected;
}

function boundProperty(target, property) {
  const value = Reflect.get(target, property, target);
  return typeof value === "function" ? value.bind(target) : value;
}
