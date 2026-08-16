from pathlib import Path

def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if text.count(old) != 1:
        raise SystemExit(f"{path}: expected exactly one patch target, found {text.count(old)}")
    p.write_text(text.replace(old, new, 1))

replace_once(
    "src/lib/planning-document-catalog.mjs",
    'const LOW_VALUE_CLASSES = new Set(["decision", "supporting", "unknown"]);\n',
    ''
)
replace_once(
    "src/lib/planning-document-catalog.mjs",
    '''  if (!supported) return false;
  if (options.includeLowValuePlanningDocuments) return true;
  return !LOW_VALUE_CLASSES.has(document.classification);''',
    '''  return supported;'''
)
replace_once(
    "test/planning-document-catalog.test.mjs",
    '''test("catalog excludes low-value decision/supporting PDFs from extraction by default", () => {
  const catalog = buildPlanningDocumentCatalog([{
    selectedShard: 4,
    results: [{
      application: { key: "entity:3" },
      documents: [
        { status: "downloaded", contentHash: HASH_A, objectPath: `objects/${HASH_A}.pdf`, contentType: "application/pdf", classification: "decision" },
        { status: "downloaded", contentHash: HASH_B, objectPath: `objects/${HASH_B}.pdf`, contentType: "application/pdf", classification: "elevation" }
      ]
    }]
  }]);
  assert.equal(catalog.uniqueDocuments, 2);
  assert.equal(catalog.extractionQueueItems, 1);
  assert.equal(catalog.extractionQueue[0].contentHash, HASH_B);
  assert.equal(catalog.extractionQueue[0].shard, 4);
});''',
    '''test("catalog extracts every supported acquired planning PDF regardless of priority class", () => {
  const catalog = buildPlanningDocumentCatalog([{
    selectedShard: 4,
    results: [{
      application: { key: "entity:3" },
      documents: [
        { status: "downloaded", contentHash: HASH_A, objectPath: `objects/${HASH_A}.pdf`, contentType: "application/pdf", classification: "decision" },
        { status: "downloaded", contentHash: HASH_B, objectPath: `objects/${HASH_B}.pdf`, contentType: "application/pdf", classification: "supporting" }
      ]
    }]
  }]);
  assert.equal(catalog.uniqueDocuments, 2);
  assert.equal(catalog.extractionQueueItems, 2);
  assert.deepEqual(new Set(catalog.extractionQueue.map((item) => item.contentHash)), new Set([HASH_A, HASH_B]));
  assert.ok(catalog.extractionQueue.every((item) => item.shard === 4));
});'''
)

replace_once(
    "src/lib/planning-documents.mjs",
    '''    ["landscape", /\\b(landscape|landscaping|planting|arboricultural|tree plan|soft landscape|hard landscape)\\b/],''',
    '''    ["supporting", /\\b(landscape and visual impact assessment|visual impact assessment|lvia|environmental impact assessment|environmental statement|heritage statement|ecology report|arboricultural impact assessment)\\b/],
    ["landscape", /\\b(landscape plan|landscaping plan|landscape layout|planting plan|tree plan|soft landscape(?: plan| layout)?|hard landscape(?: plan| layout| materials schedule)?|arboricultural plan)\\b/],'''
)
replace_once(
    "test/planning-documents.test.mjs",
    '''  assert.equal(classifyPlanningDocument("Hard Landscape Materials Schedule", "https://x.example/materials.pdf"), "landscape");
  assert.equal(classifyPlanningDocument("Supporting note", "https://x.example/note.pdf"), "supporting");''',
    '''  assert.equal(classifyPlanningDocument("Hard Landscape Materials Schedule", "https://x.example/materials.pdf"), "landscape");
  assert.equal(classifyPlanningDocument("Proposed Soft Landscape Plan", "https://x.example/soft-landscape.pdf"), "landscape");
  assert.equal(classifyPlanningDocument("Landscape and Visual Impact Assessment", "https://x.example/lvia.pdf"), "supporting");
  assert.equal(classifyPlanningDocument("LVIA Environmental Statement", "https://x.example/report.pdf"), "supporting");
  assert.equal(classifyPlanningDocument("Supporting note", "https://x.example/note.pdf"), "supporting");'''
)

replace_once(
    "src/lib/planning-changeset-compiler.mjs",
    '''  if (/\\b(tree|trees|planting|hedge|shrub|woodland)\\b/.test(text) && areaGeometry) {
    return hit("vegetation", 0.86, "vegetation-area-label", "vegetation-label");
  }

  const material = candidate?.compiledMaterial || null;''',
    '''  if (/\\b(tree|trees|planting|hedge|shrub|woodland)\\b/.test(text) && areaGeometry) {
    return hit("vegetation", 0.86, "vegetation-area-label", "vegetation-label");
  }

  const corroboratedTarget = implementationCorroboratedTarget(candidate, map);
  if (corroboratedTarget) {
    return {
      kind: corroboratedTarget.kind,
      confidence: 0.96,
      reason: "implementation-corroborated-existing-feature-kind",
      matchOnly: false,
      targetFeatureId: corroboratedTarget.id,
      signals: ["post-decision-current-feature-corroboration"]
    };
  }

  const material = candidate?.compiledMaterial || null;'''
)
replace_once(
    "src/lib/planning-changeset-compiler.mjs",
    '''function inferKindFromExistingGeometry(candidate, features, options) {''',
    '''function implementationCorroboratedTarget(candidate, map) {
  const featureId = candidate?.implementationCorroboration?.featureId ||
    candidate?.planningTemporal?.implementationCorroboration?.featureId ||
    null;
  if (!featureId) return null;
  const feature = (map?.features || []).find((entry) => entry?.id === featureId);
  if (!feature?.localGeometry || !TOPOLOGY_KINDS.has(feature.kind)) return null;
  return feature;
}

function inferKindFromExistingGeometry(candidate, features, options) {'''
)
with Path("test/planning-changeset-compiler.test.mjs").open("a") as handle:
    handle.write('''

test("post-decision corroboration target disambiguates otherwise ambiguous current planning geometry", () => {
  const map = mapWith([
    feature("osm:a", "building", polygon(0, 0, 10, 10)),
    feature("osm:b", "building", polygon(0.1, 0.1, 10.1, 10.1))
  ]);
  const candidate = current({
    id: "plan:corroborated",
    classification: "location_plan",
    semantic: "site-edge-or-route",
    localGeometry: polygon(0, 0, 12, 12)
  });
  candidate.planningTemporal.implementationCorroboration = { featureId: "osm:a", matchScore: 0.91 };
  candidate.planningTemporal.reason = "post-decision-current-osm-geometry-corroboration";
  const evidence = {
    geometryCandidates: [candidate],
    materialObservations: []
  };
  const compiled = compilePlanningChangeSet(map, evidence);
  assert.equal(compiled.counts.review, 0);
  assert.equal(compiled.changes[0].targetFeatureId, "osm:a");
  assert.equal(compiled.changes[0].semanticReason, "implementation-corroborated-existing-feature-kind");
  assert.ok(compiled.counts.replace + compiled.counts.retain === 1);
});
''')

replace_once(
    "src/lib/planning-object-reconstruction.mjs",
    '''  const crownSpreadM = finiteInRange(schedule.crownSpreadM, 0.5, 60);
  if (crownSpreadM == null) return { accepted: false, reason: "tree-schedule-crown-spread-missing-or-invalid" };
  const diameterMm = finiteInRange(schedule.diameterMm, 10, 5000);
  return {
    accepted: true,
    value: baseRecord(candidate, object, "tree", {
      anchor: { x: round(anchor[0]), z: round(anchor[1]) },
      heightM,
      crownSpreadM,
      trunkDiameterM: diameterMm == null ? null : round(diameterMm / 1000),
      species: schedule.species || null,
      shapeModel: "measured-envelope-natural-tree-v1",
      geometryPolicy: {
        deterministic: true,
        measuredHeightHardLimit: true,
        measuredCrownSpreadHardLimit: true,
        naturalTrunkBranchRootGeometry: true
      },
      dimensionSources: { height: "current-schedule", crownSpread: "current-schedule", trunkDiameter: diameterMm == null ? null : "current-schedule" }
    })
  };''',
    '''  const crownSpreadM = finiteInRange(schedule.crownSpreadM, 0.5, 60);
  const diameterMm = finiteInRange(schedule.diameterMm, 10, 5000);
  return {
    accepted: true,
    value: baseRecord(candidate, object, "tree", {
      anchor: { x: round(anchor[0]), z: round(anchor[1]) },
      heightM,
      crownSpreadM,
      trunkDiameterM: diameterMm == null ? null : round(diameterMm / 1000),
      species: schedule.species || null,
      shapeModel: "user-schematic-tall-tree-v1",
      geometryPolicy: {
        deterministic: true,
        measuredHeightHardLimit: true,
        fixedSchematicFootprint: true,
        horizontalShapeFromUserSchematic: true,
        crownSpreadControlsGeometry: false
      },
      dimensionSources: {
        height: "current-schedule",
        crownSpread: crownSpreadM == null ? null : "current-schedule",
        trunkDiameter: diameterMm == null ? null : "current-schedule"
      }
    })
  };'''
)
replace_once(
    "test/planning-object-reconstruction.test.mjs",
    '''test("tree with missing crown spread is deferred instead of receiving an inferred size", () => {
  const tree = candidate({ objectType: "tree", subtype: "tree", code: "T-1", scheduleAttributes: { heightM: 11 } });
  const result = reconstructPlanningObjects3dFromEvidence({ geometryCandidates: [tree] });
  assert.equal(result.summary.reconstructedObjects, 0);
  assert.equal(result.summary.deferredMissingDimensions, 1);
  assert.equal(result.deferred[0].reason, "tree-schedule-crown-spread-missing-or-invalid");
});''',
    '''test("height-only tree uses the fixed supplied schematic without inventing crown dimensions", () => {
  const tree = candidate({ objectType: "tree", subtype: "tree", code: "T-1", scheduleAttributes: { heightM: 11 } });
  const result = reconstructPlanningObjects3dFromEvidence({ geometryCandidates: [tree] });
  assert.equal(result.summary.reconstructedObjects, 1);
  assert.equal(result.summary.trees, 1);
  assert.equal(result.objects[0].heightM, 11);
  assert.equal(result.objects[0].crownSpreadM, null);
  assert.equal(result.objects[0].shapeModel, "user-schematic-tall-tree-v1");
  assert.equal(result.objects[0].geometryPolicy.fixedSchematicFootprint, true);
});'''
)

replace_once(
    "src/lib/planning-object-renderer.mjs",
    'treeShapeModel: "deterministic-natural-tree-v1",',
    'treeShapeModel: "user-schematic-tall-tree-v1",'
)
replace_once(
    "src/lib/planning-object-renderer.mjs",
    '''  const totalHeight = Math.max(2, Math.round(Number(object.heightM)));
  const crownDiameter = Math.max(1, Math.round(Number(object.crownSpreadM)));
  if (!Number.isFinite(totalHeight) || !Number.isFinite(crownDiameter)) return 0;''',
    '''  const totalHeight = Math.max(2, Math.round(Number(object.heightM)));
  const rawCrownDiameter = Number(object.crownSpreadM);
  const crownDiameter = Number.isFinite(rawCrownDiameter) && rawCrownDiameter > 0
    ? Math.round(rawCrownDiameter)
    : null;
  if (!Number.isFinite(totalHeight)) return 0;'''
)
