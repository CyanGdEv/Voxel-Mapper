export const PLANNING_OBJECT_TYPES = Object.freeze([
  "ride_component", "structure", "roof_element", "facade_element", "tree", "landscape",
  "barrier", "lighting", "drainage", "water", "signage", "street_furniture", "path_detail",
  "utility", "accessibility", "transport_detail"
]);

const DEFAULT_LABEL_RADIUS_PT = 80;
const DEFAULT_MAX_NEARBY_TEXT = 14;
const DEFAULT_OBSERVATION_RADIUS_PT = 100;

const COMMON_TREE_SPECIES = [
  "oak", "english oak", "sessile oak", "beech", "birch", "silver birch", "maple", "field maple",
  "sycamore", "ash", "lime", "linden", "hornbeam", "hawthorn", "rowan", "willow", "alder", "elm",
  "cherry", "wild cherry", "scots pine", "pine", "spruce", "fir", "cedar", "yew", "poplar", "plane"
];

const RULES = [
  rule("accessibility", "accessible_ramp", /\b(?:accessible|disabled|dda|wheelchair)\s+(?:access\s+)?ramp\b|\bramp\s+(?:to\s+)?(?:accessible|disabled)\b/, 0.99),
  rule("accessibility", "accessible_parking", /\b(?:accessible|disabled|blue\s+badge)\s+(?:parking\s+)?(?:bay|space)\b/, 0.99),
  rule("accessibility", "tactile_paving", /\b(?:tactile|blister|corduroy)\s+(?:paving|surface)\b/, 0.98),
  rule("accessibility", "lift", /\b(?:passenger|platform|wheelchair|accessible)\s+lift\b/, 0.96),

  rule("roof_element", "roof_ridge", /\b(?:roof\s+)?ridge(?:\s+line)?\b/, 0.98),
  rule("roof_element", "roof_hip", /\b(?:roof\s+)?hip(?:\s+line)?\b/, 0.97),
  rule("roof_element", "roof_valley", /\b(?:roof\s+)?valley(?:\s+line)?\b/, 0.97),
  rule("roof_element", "eaves", /\beaves?(?:\s+line|\s+level)?\b/, 0.96),
  rule("roof_element", "parapet", /\bparapet(?:\s+wall|\s+level)?\b/, 0.96),
  rule("roof_element", "rooflight", /\b(?:roof\s*light|skylight|lantern\s+light)\b/, 0.98),
  rule("roof_element", "gutter", /\b(?:box\s+)?gutter|rainwater\s+gutter\b/, 0.94),
  rule("roof_element", "roof_plant", /\broof(?:top)?\s+(?:plant|ahu|equipment|unit)\b/, 0.96),

  rule("facade_element", "door", /\b(?:entrance|exit|service|roller\s+shutter|double|single|fire)\s+door\b|\bdoor\s+(?:opening|set|type)\b/, 0.96),
  rule("facade_element", "window", /\b(?:window|glazed\s+opening|curtain\s+wall)\b/, 0.94),
  rule("facade_element", "cladding_zone", /\b(?:wall|facade|façade)\s+cladding\b|\bcladding\s+(?:panel|zone|type)\b/, 0.94),
  rule("facade_element", "canopy", /\bentrance\s+canopy\b|\bdoor\s+canopy\b/, 0.94),

  rule("structure", "retaining_wall", /\bretaining\s+wall\b/, 0.99),
  rule("structure", "column", /\b(?:structural\s+)?column\b|\bcolumn\s+(?:grid|line|type)\b/, 0.96),
  rule("structure", "beam", /\b(?:steel|timber|concrete|structural)\s+beam\b|\bbeam\s+(?:line|type)\b/, 0.96),
  rule("structure", "truss", /\b(?:roof\s+)?truss\b/, 0.97),
  rule("structure", "brace", /\b(?:cross|diagonal|structural)\s+brac(?:e|ing)\b/, 0.97),
  rule("structure", "foundation", /\b(?:pad|strip|raft)\s+foundation\b|\bfoundation\s+(?:pad|plan|type)\b/, 0.97),
  rule("structure", "footing", /\b(?:pad\s+)?footing\b|\bbase\s+plate\b/, 0.96),
  rule("structure", "gantry", /\bgantry\b/, 0.96),
  rule("structure", "platform", /\b(?:maintenance|service|access|operator)\s+platform\b/, 0.95),
  rule("structure", "stair", /\b(?:external|escape|access|maintenance)\s+stair(?:case)?\b/, 0.95),
  rule("structure", "bridge", /\b(?:pedestrian|service|access)\s+bridge\b/, 0.95),

  rule("tree", "tree", /\b(?:existing|retained|proposed|new|removed|fell|felled)?\s*tree\s*(?:no\.?\s*)?[a-z]{0,3}\s*\d{1,4}[a-z]?\b|\btree\s+(?:species|schedule|planting|pit)\b/, 0.98),
  rule("tree", "tree", new RegExp(`\\b(?:${COMMON_TREE_SPECIES.map(escapeRegex).join("|")})\\b.*\\b(?:tree|retained|removed|proposed|stem|crown)\\b|\\b(?:tree|retained|removed|proposed|stem|crown)\\b.*\\b(?:${COMMON_TREE_SPECIES.map(escapeRegex).join("|")})\\b`), 0.95),

  rule("landscape", "hedge", /\b(?:existing|proposed|new|retained)?\s*hedge(?:row)?\b/, 0.97),
  rule("landscape", "planting_bed", /\b(?:ornamental|shrub|mixed|native)?\s*planting\s+(?:bed|area|zone)\b|\bshrub\s+bed\b/, 0.96),
  rule("landscape", "grass_area", /\b(?:amenity|species[- ]rich|meadow)?\s*(?:grass|turf)\s+(?:area|zone)\b/, 0.94),
  rule("landscape", "woodland", /\b(?:woodland|scrub|meadow|wildflower)\s+(?:area|planting|zone)\b/, 0.95),
  rule("landscape", "rock_boulder", /\b(?:landscape\s+)?(?:rock|boulder)s?\b/, 0.92),
  rule("landscape", "planter", /\b(?:raised\s+)?planter\b/, 0.94),

  rule("barrier", "acoustic_barrier", /\b(?:acoustic|noise)\s+(?:fence|barrier|screen|wall)\b/, 0.99),
  rule("barrier", "fence", /\b(?:boundary|security|timber|mesh|palisade|post\s+and\s+rail)?\s*fenc(?:e|ing)\b/, 0.97),
  rule("barrier", "gate", /\b(?:pedestrian|vehicle|service|access|security)?\s*gate(?:s)?\b/, 0.96),
  rule("barrier", "railing", /\b(?:guard|pedestrian|metal)?\s*railings?\b|\bbalustrade\b/, 0.95),
  rule("barrier", "boundary_wall", /\bboundary\s+wall\b|\bscreen\s+wall\b/, 0.96),
  rule("barrier", "bollard", /\b(?:security|removable|fixed)?\s*bollard\b/, 0.94),

  rule("lighting", "lighting_column", /\b(?:lighting|lamp|light)\s+(?:column|post)\b|\blighting\s+column\s*[a-z]{0,3}\d+\b/, 0.99),
  rule("lighting", "bollard_light", /\b(?:illuminated|lighting?)\s+bollard\b|\bbollard\s+light\b/, 0.97),
  rule("lighting", "floodlight", /\bflood\s*light|floodlight\b/, 0.98),
  rule("lighting", "luminaire", /\bluminaire\b|\blight\s+fitting\b/, 0.95),

  rule("drainage", "manhole", /\b(?:drainage\s+)?manhole\b|\bmh\s*[-:]?\s*\d+\b/, 0.98),
  rule("drainage", "gully", /\b(?:road|channel|slot)?\s*gully\b/, 0.97),
  rule("drainage", "drain", /\b(?:foul|surface\s+water|storm|linear|channel)\s+drain\b/, 0.97),
  rule("drainage", "pipe", /\b(?:foul|storm|surface\s+water|drainage)\s+(?:pipe|sewer)\b|\b\d{2,4}\s*mm\s+(?:pipe|sewer)\b/, 0.96),
  rule("drainage", "culvert", /\bculvert\b/, 0.98),
  rule("drainage", "outfall", /\boutfall\b/, 0.98),
  rule("drainage", "swale", /\b(?:drainage|suds|bioswale)?\s*swale\b/, 0.98),
  rule("drainage", "attenuation_basin", /\b(?:attenuation|detention|retention)\s+(?:basin|pond|tank)\b/, 0.98),
  rule("drainage", "rain_garden", /\brain\s+garden\b/, 0.97),

  rule("water", "pond", /\b(?:existing|proposed|ornamental)?\s*pond\b/, 0.96),
  rule("water", "lake", /\b(?:existing|proposed)?\s*lake\b/, 0.97),
  rule("water", "watercourse", /\b(?:stream|watercourse|channel|ditch)\b/, 0.93),

  rule("signage", "wayfinding_sign", /\b(?:wayfinding|directional|information|info)\s+(?:sign|board|totem)\b/, 0.98),
  rule("signage", "sign", /\b(?:signage|sign\s+post|sign\s+type|sign\s+no)\b/, 0.95),

  rule("street_furniture", "bench", /\b(?:park|timber|metal)?\s*bench\b/, 0.97),
  rule("street_furniture", "bin", /\b(?:litter|waste|recycling)?\s*bin\b/, 0.96),
  rule("street_furniture", "picnic_table", /\bpicnic\s+table\b/, 0.98),
  rule("street_furniture", "cycle_rack", /\b(?:cycle|bicycle|bike)\s+(?:rack|stand)\b/, 0.97),
  rule("street_furniture", "drinking_fountain", /\bdrinking\s+fountain\b/, 0.98),
  rule("street_furniture", "shelter", /\b(?:waiting|visitor|smoking|cycle)\s+shelter\b/, 0.94),

  rule("path_detail", "kerb", /\b(?:flush|raised|dropped|conservation|granite)?\s*kerb\b|\bcurb\b/, 0.97),
  rule("path_detail", "edging", /\b(?:path|paving|steel|timber)\s+edging\b/, 0.94),
  rule("path_detail", "steps", /\b(?:external|landscape|access)?\s*steps?\b/, 0.93),
  rule("path_detail", "ramp", /\b(?:pedestrian|path|access)?\s*ramp\b/, 0.93),
  rule("path_detail", "drainage_channel", /\b(?:slot|linear)\s+channel\b/, 0.94),
  rule("path_detail", "paving_module", /\b(?:paving|paver|slab)\s+(?:module|size|pattern|course|bond)\b/, 0.95),

  rule("utility", "substation", /\b(?:electrical|electricity)?\s*substation\b/, 0.99),
  rule("utility", "transformer", /\btransformer\b/, 0.98),
  rule("utility", "generator", /\b(?:standby|backup|diesel)?\s*generator\b/, 0.97),
  rule("utility", "ahu", /\b(?:ahu|air\s+handling\s+unit)\b/, 0.98),
  rule("utility", "hvac", /\b(?:hvac|air\s+conditioning|condenser\s+unit)\b/, 0.96),
  rule("utility", "vent", /\b(?:extract|ventilation|exhaust)\s+(?:vent|stack|duct)\b/, 0.96),
  rule("utility", "tank", /\b(?:water|fuel|storage|sprinkler)\s+tank\b/, 0.95),
  rule("utility", "plant_enclosure", /\b(?:plant|services?)\s+(?:room|enclosure|compound)\b/, 0.94),

  rule("transport_detail", "parking_bay", /\b(?:parking|car)\s+bay\b/, 0.96),
  rule("transport_detail", "loading_bay", /\bloading\s+bay\b/, 0.98),
  rule("transport_detail", "service_yard", /\bservice\s+yard\b/, 0.97),
  rule("transport_detail", "dropoff", /\b(?:drop[- ]?off|pick[- ]?up)\s+(?:area|bay|zone)\b/, 0.96),
  rule("transport_detail", "road_marking", /\b(?:road|carriageway|parking)\s+markings?\b/, 0.94)
];

export function enrichPlanningObjectEvidence(extraction, options = {}) {
  if (!extraction?.normalizedEvidence || !Array.isArray(extraction.pages)) return emptySummary("no-normalized-evidence");
  const candidates = extraction.normalizedEvidence.geometryCandidates || [];
  const pageIndex = new Map(extraction.pages.map((page) => [Number(page.pageNumber || 1), page]));
  const objects = [];
  const counts = {};

  for (const candidate of candidates) {
    const page = pageIndex.get(Number(candidate.pageNumber || 1));
    const nearby = nearbyTextForCandidate(candidate, page?.text?.items || [], options);
    const joined = nearby.map((entry) => entry.text).join(" ");
    const classification = candidate.rideStructureEvidence
      ? ridePlanningObject(candidate.rideStructureEvidence)
      : classifyPlanningObjectText(joined, { classification: candidate.classification, closed: candidate.closed });
    if (!classification) continue;

    const center = boundsCenter(candidate.boundsPt);
    const attributes = extractPlanningObjectAttributes(joined, classification);
    const materialCandidates = nearbyEvidence(
      extraction.normalizedEvidence.materialObservations || [], candidate, center,
      Number(options.planningObjectObservationRadiusPt ?? DEFAULT_OBSERVATION_RADIUS_PT)
    ).map(compactMaterialObservation);
    const levelCandidates = nearbyEvidence(
      extraction.normalizedEvidence.verticalObservations || [], candidate, center,
      Number(options.planningObjectObservationRadiusPt ?? DEFAULT_OBSERVATION_RADIUS_PT)
    ).map(compactVerticalObservation);
    if (materialCandidates.length) attributes.materialCandidates = materialCandidates;
    if (levelCandidates.length) attributes.levelCandidates = levelCandidates;

    const object = {
      schemaVersion: 1,
      id: `planning-object:${candidate.id || `${candidate.contentHash || "document"}:p${candidate.pageNumber || 1}:${candidate.vectorPathIndex ?? 0}`}`,
      objectType: classification.objectType,
      subtype: classification.subtype,
      semantic: classification.semantic,
      confidence: round(Math.min(Number(classification.confidence || 0.8), Number(candidate.confidence ?? 1))),
      geometryRef: candidate.id || null,
      geometryRole: candidate.closed ? "area-or-footprint" : "line-or-symbol",
      sourceVectorPathIndex: candidate.vectorPathIndex ?? null,
      contentHash: candidate.contentHash || extraction.contentHash || null,
      pageNumber: Number(candidate.pageNumber || 1),
      classification: normalizeClass(candidate.classification || extraction.classification),
      nearbyText: nearby.map((entry) => entry.text).slice(0, 10),
      objectCode: attributes.objectCode || null,
      attributes,
      coordinateSpace: candidate.coordinateSpace || "pdf-user-space-points",
      anchorPt: center ? { x: round(center[0], 3), y: round(center[1], 3) } : null,
      source: candidate.rideStructureEvidence ? "planning-pdf-ride-object-link" : "planning-pdf-universal-object-semantic",
      authority: {
        georegistrationRequired: candidate.georegistrationRequired !== false,
        temporalResolutionRequired: true,
        spatialAuthorityEligible: candidate.spatialAuthorityEligible !== false,
        worldGeometryAuthority: false,
        terrainGeometryAuthority: false,
        terrainElevationAuthority: false
      }
    };
    candidate.planningObject = object;
    objects.push(object);
    counts[object.objectType] = (counts[object.objectType] || 0) + 1;
  }

  for (const template of extraction.normalizedEvidence.rideStructureTemplates || []) {
    if (template.planningObject) continue;
    const object = {
      schemaVersion: 1,
      id: `planning-object:${template.id || `${template.contentHash || "document"}:p${template.pageNumber || 1}:ride-template`}`,
      objectType: "ride_component",
      subtype: template.component || "ride_structure_template",
      semantic: `ride-template-${template.component || "structure"}`,
      confidence: round(Number(template.confidence ?? 0.9)),
      geometryRef: null,
      geometryRole: "non-spatial-design-template",
      contentHash: template.contentHash || extraction.contentHash || null,
      pageNumber: Number(template.pageNumber || 1),
      classification: normalizeClass(template.classification),
      objectCode: template.supportCode || null,
      attributes: {
        objectCode: template.supportCode || null,
        explicitHeightM: finiteOrNull(template.explicitHeightM),
        scaleDenominator: finiteOrNull(template.scaleDenominator)
      },
      coordinateSpace: "pdf-template-space",
      anchorPt: null,
      source: "planning-pdf-ride-object-template",
      authority: {
        georegistrationRequired: false,
        temporalResolutionRequired: true,
        spatialAuthorityEligible: false,
        worldGeometryAuthority: false,
        terrainGeometryAuthority: false,
        terrainElevationAuthority: false,
        linkageRequired: true
      }
    };
    template.planningObject = object;
    objects.push(object);
    counts.ride_component = (counts.ride_component || 0) + 1;
  }

  const textOnly = extractTextOnlyObjectObservations(extraction, objects, options);
  extraction.normalizedEvidence.planningObjectTextObservations = textOnly;
  preserveTextOnlyInDrawingMetadata(extraction, textOnly);
  extraction.planningObjectExtraction = {
    schemaVersion: 1,
    status: objects.length || textOnly.length ? "extracted" : "no-universal-objects",
    objectCount: objects.length,
    textOnlyObservationCount: textOnly.length,
    byType: counts,
    policy: {
      evidenceOnly: true,
      mutatesCandidateKind: false,
      georegistrationStillRequired: true,
      temporalCurrentStateStillRequired: true,
      textOnlyRowsRequireExactLinkage: true,
      terrainGeometryMutable: false,
      terrainElevationMutable: false
    }
  };
  return extraction.planningObjectExtraction;
}

export function classifyPlanningObjectText(value, context = {}) {
  const text = normalizeText(value);
  if (!text) return null;

  // A drawing label can legitimately contain both a generic structural word
  // and a more specific domain phrase: e.g. "lighting column", "accessible
  // ramp" or "acoustic wall". First-match ordering made those brittle. Rank
  // every matching rule by evidence confidence, then by matched phrase length;
  // only use declaration order as the final deterministic tie-break.
  const matches = [];
  for (let index = 0; index < RULES.length; index += 1) {
    const entry = RULES[index];
    const match = text.match(entry.pattern);
    if (!match) continue;
    matches.push({ entry, index, matchLength: String(match[0] || "").trim().length });
  }
  if (!matches.length) return null;
  matches.sort((a, b) =>
    Number(b.entry.confidence || 0) - Number(a.entry.confidence || 0) ||
    b.matchLength - a.matchLength ||
    a.index - b.index
  );
  const winner = matches[0].entry;
  return {
    objectType: winner.objectType,
    subtype: winner.subtype,
    semantic: `${winner.objectType}-${winner.subtype}`,
    confidence: winner.confidence,
    classification: normalizeClass(context.classification),
    closed: Boolean(context.closed)
  };
}

export function extractPlanningObjectAttributes(value, classification = null) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  const text = normalizeText(raw);
  const attributes = {};
  const objectCode = extractObjectCode(raw, classification);
  if (objectCode) attributes.objectCode = objectCode;

  const height = firstNumber(text, /\b(?:overall\s+height|column\s+height|height|ht)\s*[:=]?\s*([0-9]{1,3}(?:\.[0-9]{1,3})?)\s*m\b/);
  if (validRange(height, 0.05, 250)) attributes.heightM = height;
  const width = firstNumber(text, /\b(?:overall\s+width|width|wd)\s*[:=]?\s*([0-9]{1,3}(?:\.[0-9]{1,3})?)\s*m\b/);
  if (validRange(width, 0.05, 250)) attributes.widthM = width;
  const length = firstNumber(text, /\b(?:overall\s+length|length|len)\s*[:=]?\s*([0-9]{1,4}(?:\.[0-9]{1,3})?)\s*m\b/);
  if (validRange(length, 0.05, 2000)) attributes.lengthM = length;
  const spacing = firstNumber(text, /\b(?:spacing|centres|centers|c\/c)\s*[:=]?\s*([0-9]{1,3}(?:\.[0-9]{1,3})?)\s*m\b/);
  if (validRange(spacing, 0.05, 100)) attributes.spacingM = spacing;

  const pipeMm = firstNumber(text, /\b(?:dia(?:meter)?\.?\s*)?([0-9]{2,4})\s*mm\s+(?:dia(?:meter)?\.?\s*)?(?:pipe|sewer|drain|culvert)\b|\b(?:pipe|sewer|drain|culvert)\s+(?:dia(?:meter)?\.?\s*)?([0-9]{2,4})\s*mm\b/, true);
  if (validRange(pipeMm, 20, 5000)) attributes.pipeDiameterMm = pipeMm;
  const diameterMm = firstNumber(text, /\b(?:stem|trunk|post|column)?\s*(?:diameter|dia\.?|Ø)\s*[:=]?\s*([0-9]{2,4})\s*mm\b/);
  if (validRange(diameterMm, 10, 5000)) attributes.diameterMm = diameterMm;
  const crown = firstNumber(text, /\b(?:crown\s+spread|canopy\s+spread|spread)\s*[:=]?\s*([0-9]{1,3}(?:\.[0-9]{1,2})?)\s*m\b/);
  if (validRange(crown, 0.1, 100)) attributes.crownSpreadM = crown;

  const pitch = firstNumber(text, /\b(?:roof\s+)?pitch\s*[:=]?\s*([0-9]{1,2}(?:\.[0-9])?)\s*(?:deg|degree|degrees|°)\b/);
  if (validRange(pitch, 0, 89.9)) attributes.pitchDeg = pitch;
  const ratio = text.match(/\b(?:gradient|fall|slope|ramp)?\s*[:=]?\s*1\s*[:/]\s*([0-9]{1,4}(?:\.[0-9]+)?)\b/);
  if (ratio && Number(ratio[1]) > 0) attributes.gradientRatio = `1:${Number(ratio[1])}`;
  const percent = firstNumber(text, /\b(?:gradient|fall|slope)\s*[:=]?\s*([0-9]{1,2}(?:\.[0-9]+)?)\s*%\b/);
  if (validRange(percent, 0, 100)) attributes.gradientPercent = percent;

  const dimensions = raw.match(/\b([0-9]{2,5}(?:\.[0-9]+)?)\s*[x×]\s*([0-9]{2,5}(?:\.[0-9]+)?)\s*mm\b/i);
  if (dimensions) attributes.sizeMm = [Number(dimensions[1]), Number(dimensions[2])];
  const ral = raw.match(/\bRAL\s*[-:]?\s*([0-9]{4})\b/i);
  if (ral) attributes.ral = `RAL ${ral[1]}`;

  const status = detectObjectStatus(text);
  if (status) attributes.status = status;
  if (classification?.objectType === "tree") {
    const species = extractTreeSpecies(raw);
    if (species) attributes.species = species;
  }
  return attributes;
}

function extractTextOnlyObjectObservations(extraction, geometryObjects, options) {
  const observations = [];
  const geometryCodes = new Set(geometryObjects.map((entry) => entry.objectCode).filter(Boolean));
  for (const page of extraction.pages || []) {
    const lines = logicalTextLines(page.text?.items || [], Number(options.planningObjectLineDeltaPt ?? 4));
    for (const line of lines) {
      const classification = classifyPlanningObjectText(line.text, { classification: extraction.classification });
      if (!classification) continue;
      const attributes = extractPlanningObjectAttributes(line.text, classification);
      const code = attributes.objectCode || null;
      if (code && geometryCodes.has(code)) continue;
      if (!code && classification.confidence < 0.97) continue;
      observations.push({
        schemaVersion: 1,
        id: `planning-object-text:${extraction.contentHash || "document"}:p${page.pageNumber || 1}:${line.index}:${classification.objectType}:${classification.subtype}`,
        objectType: classification.objectType,
        subtype: classification.subtype,
        semantic: classification.semantic,
        objectCode: code,
        attributes,
        raw: line.text,
        contentHash: extraction.contentHash || null,
        pageNumber: Number(page.pageNumber || 1),
        classification: normalizeClass(extraction.classification),
        xPt: finiteOrNull(line.xPt),
        yPt: finiteOrNull(line.yPt),
        coordinateSpace: "pdf-user-space-points",
        confidence: round(Math.max(0.65, classification.confidence - 0.06)),
        source: "planning-pdf-object-schedule-text",
        spatialAuthorityEligible: false,
        linkageRequired: true,
        georegistrationRequired: false,
        temporalResolutionRequired: true,
        worldGeometryAuthority: false,
        terrainGeometryAuthority: false,
        terrainElevationAuthority: false
      });
    }
  }
  return dedupeTextObservations(observations);
}

function preserveTextOnlyInDrawingMetadata(extraction, observations) {
  if (!observations.length) return;
  const byPage = new Map();
  for (const observation of observations) {
    const page = Number(observation.pageNumber || 1);
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push(observation);
  }
  const metadata = [...(extraction.normalizedEvidence.drawingMetadata || [])];
  for (const [pageNumber, values] of byPage) {
    let target = metadata.find((entry) => Number(entry.pageNumber || 1) === pageNumber && (!entry.contentHash || entry.contentHash === extraction.contentHash));
    if (!target) {
      target = { contentHash: extraction.contentHash || null, pageNumber, scaleDenominator: null, drawingNumber: null, revision: null, status: null, issueDate: null, source: "pdf-object-schedule-metadata" };
      metadata.push(target);
    }
    target.planningObjectTextObservations = values;
  }
  extraction.normalizedEvidence.drawingMetadata = metadata;
  for (const page of extraction.pages || []) {
    const values = byPage.get(Number(page.pageNumber || 1));
    if (!values?.length) continue;
    page.metadata ||= { pageNumber: Number(page.pageNumber || 1), source: "pdf-object-schedule-metadata" };
    page.metadata.planningObjectTextObservations = values;
  }
}

function ridePlanningObject(evidence) {
  const subtype = evidence?.subtype || "ride_component";
  return { objectType: "ride_component", subtype, semantic: `ride-component-${subtype}`, confidence: Number(evidence?.confidence ?? 0.96) };
}

function nearbyTextForCandidate(candidate, items, options) {
  const bounds = candidate.boundsPt;
  if (!bounds) return [];
  const radius = Number(options.planningObjectLabelRadiusPt ?? DEFAULT_LABEL_RADIUS_PT);
  const max = Math.max(1, Math.floor(Number(options.maxPlanningObjectNearbyText ?? DEFAULT_MAX_NEARBY_TEXT)));
  const center = boundsCenter(bounds);
  const ranked = [];
  for (const item of items || []) {
    const x = Number(item?.xPt), y = Number(item?.yPt);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const dx = x < bounds.minX ? bounds.minX - x : x > bounds.maxX ? x - bounds.maxX : 0;
    const dy = y < bounds.minY ? bounds.minY - y : y > bounds.maxY ? y - bounds.maxY : 0;
    const edgeDistance = Math.hypot(dx, dy);
    if (edgeDistance > radius) continue;
    ranked.push({ ...item, edgeDistance, centerDistance: center ? Math.hypot(x - center[0], y - center[1]) : edgeDistance });
  }
  ranked.sort((a, b) => a.edgeDistance - b.edgeDistance || a.centerDistance - b.centerDistance || String(a.text || "").localeCompare(String(b.text || "")));
  return ranked.slice(0, max);
}

function nearbyEvidence(values, candidate, center, radius) {
  if (!center) return [];
  return (values || []).filter((entry) => {
    if (candidate.contentHash && entry.contentHash && candidate.contentHash !== entry.contentHash) return false;
    if (Number(entry.pageNumber || 1) !== Number(candidate.pageNumber || 1)) return false;
    const x = Number(entry.xPt), y = Number(entry.yPt);
    return Number.isFinite(x) && Number.isFinite(y) && Math.hypot(x - center[0], y - center[1]) <= radius;
  }).sort((a, b) => distanceToCenter(a, center) - distanceToCenter(b, center) || Number(b.confidence || 0) - Number(a.confidence || 0)).slice(0, 6);
}

function logicalTextLines(items, tolerancePt) {
  const values = (items || []).filter((item) => String(item?.text || "").trim()).map((item, index) => ({ ...item, index }));
  values.sort((a, b) => Number(b.yPt || 0) - Number(a.yPt || 0) || Number(a.xPt || 0) - Number(b.xPt || 0));
  const lines = [];
  for (const item of values) {
    const y = Number(item.yPt);
    let line = Number.isFinite(y) ? lines.find((entry) => Number.isFinite(entry.yPt) && Math.abs(entry.yPt - y) <= tolerancePt) : null;
    if (!line) { line = { yPt: Number.isFinite(y) ? y : null, items: [] }; lines.push(line); }
    line.items.push(item);
  }
  return lines.map((line, index) => {
    line.items.sort((a, b) => Number(a.xPt || 0) - Number(b.xPt || 0));
    return { index, xPt: finiteOrNull(line.items[0]?.xPt), yPt: finiteOrNull(line.yPt), text: line.items.map((item) => String(item.text || "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ") };
  }).filter((line) => line.text);
}

function extractObjectCode(raw, classification) {
  const text = String(raw || "").toUpperCase();
  const prefixes = classification?.objectType === "tree" ? ["T", "TREE"]
    : classification?.objectType === "lighting" ? ["L", "LC", "LP"]
    : classification?.objectType === "drainage" ? ["MH", "SW", "FW", "G", "OF"]
    : classification?.objectType === "signage" ? ["S", "SGN"]
    : classification?.objectType === "barrier" ? ["F", "FN", "G", "GT", "B"]
    : classification?.objectType === "street_furniture" ? ["B", "BN", "BIN", "P"]
    : classification?.objectType === "utility" ? ["U", "P", "PL", "TX"]
    : [];
  for (const prefix of prefixes) {
    const match = text.match(new RegExp(`\\b${escapeRegex(prefix)}\\s*[-:#]?\\s*(\\d{1,4}[A-Z]?)\\b`));
    if (match) return `${prefix}-${match[1]}`;
  }
  const labelled = text.match(/\b(?:TYPE|REF|REFERENCE|ID|NO)\s*[-:#]?\s*([A-Z]{1,5}\s*[-]?\s*\d{1,4}[A-Z]?)\b/);
  return labelled ? labelled[1].replace(/\s+/g, "-").replace(/--+/g, "-") : null;
}

function extractTreeSpecies(raw) {
  const labelled = String(raw || "").match(/\bspecies\s*[:=-]?\s*([A-Za-z][A-Za-z -]{2,50}?)(?=\s+(?:height|ht|stem|trunk|crown|spread|retained|removed|proposed|existing|new|\d+(?:\.\d+)?\s*m)\b|[,;]|$)/i);
  if (labelled) return labelled[1].trim().replace(/\s+/g, " ");
  const lower = normalizeText(raw);
  return COMMON_TREE_SPECIES.find((species) => new RegExp(`\\b${escapeRegex(species)}\\b`).test(lower)) || null;
}

function detectObjectStatus(text) {
  if (/\b(?:to\s+be\s+removed|remove|removed|fell|felled|demolish|demolished)\b/.test(text)) return "removed";
  if (/\b(?:retained|retain|existing\s+to\s+remain)\b/.test(text)) return "retained";
  if (/\b(?:proposed|new|replacement)\b/.test(text)) return "proposed";
  if (/\bexisting\b/.test(text)) return "existing";
  return null;
}

function compactMaterialObservation(entry) {
  return { material: entry.material || null, raw: entry.raw || null, confidence: round(Number(entry.confidence ?? 0.7)), source: entry.source || null, xPt: finiteOrNull(entry.xPt), yPt: finiteOrNull(entry.yPt) };
}
function compactVerticalObservation(entry) {
  return { label: entry.label || null, valueM: finiteOrNull(entry.valueM), datum: entry.datum || null, confidence: round(Number(entry.confidence ?? 0.7)), source: entry.source || null, xPt: finiteOrNull(entry.xPt), yPt: finiteOrNull(entry.yPt) };
}
function dedupeTextObservations(values) {
  const map = new Map();
  for (const value of values || []) {
    const key = `${value.contentHash || ""}:p${value.pageNumber || 1}:${value.objectType}:${value.subtype}:${value.objectCode || ""}:${round(value.xPt, 1)}:${round(value.yPt, 1)}`;
    const previous = map.get(key);
    if (!previous || Number(value.confidence || 0) > Number(previous.confidence || 0)) map.set(key, value);
  }
  return [...map.values()].sort((a, b) => Number(a.pageNumber || 0) - Number(b.pageNumber || 0) || String(a.objectType).localeCompare(String(b.objectType)) || String(a.objectCode || "").localeCompare(String(b.objectCode || "")));
}

function rule(objectType, subtype, pattern, confidence) { return { objectType, subtype, pattern, confidence }; }
function normalizeClass(value) { return String(value || "unknown").toLowerCase().trim().replace(/[\s-]+/g, "_"); }
function normalizeText(value) { return String(value || "").toLowerCase().replace(/[–—]/g, "-").replace(/[_/]+/g, " ").replace(/[^a-z0-9.%:×°-]+/g, " ").replace(/\s+/g, " ").trim(); }
function boundsCenter(bounds) { return bounds && [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every((value) => Number.isFinite(Number(value))) ? [(Number(bounds.minX) + Number(bounds.maxX)) / 2, (Number(bounds.minY) + Number(bounds.maxY)) / 2] : null; }
function distanceToCenter(entry, center) { return Math.hypot(Number(entry.xPt) - center[0], Number(entry.yPt) - center[1]); }
function finiteOrNull(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function validRange(value, min, max) { return Number.isFinite(value) && value >= min && value <= max; }
function round(value, places = 3) { if (!Number.isFinite(Number(value))) return null; const factor = 10 ** places; return Math.round(Number(value) * factor) / factor; }
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function firstNumber(text, pattern, alternatives = false) {
  const match = String(text || "").match(pattern);
  if (!match) return null;
  const values = alternatives ? match.slice(1) : [match[1]];
  for (const value of values) { const number = Number(value); if (Number.isFinite(number)) return number; }
  return null;
}
function emptySummary(status) { return { schemaVersion: 1, status, objectCount: 0, textOnlyObservationCount: 0, byType: {} }; }
