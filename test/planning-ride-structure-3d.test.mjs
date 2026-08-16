import test from "node:test";
import assert from "node:assert/strict";
import {
  enrichPlanningRideStructureEvidence,
  classifyRideStructureText
} from "../src/lib/planning-ride-structure-enrichment.mjs";
import {
  reconstructRideStructures3d,
  associateStructureToRide
} from "../src/lib/ride-structure-reconstruction.mjs";
import { renderRideStructures3d } from "../src/lib/ride-structure-renderer.mjs";

test("ride planning semantics distinguish track, supports, catwalks and sound tunnels", () => {
  assert.equal(classifyRideStructureText("TRACK CENTRE LINE").kind, "ride_track");
  assert.equal(classifyRideStructureText("SUPPORT FRAME S12").subtype, "support_frame");
  assert.equal(classifyRideStructureText("PAD FOOTING F07").subtype, "support_footing");
  assert.equal(classifyRideStructureText("maintenance catwalk").subtype, "ride_catwalk");
  const sound = classifyRideStructureText("acoustic noise attenuation tunnel");
  assert.equal(sound.kind, "structure");
  assert.equal(sound.subtype, "sound_tunnel");
  assert.equal(sound.soundTunnel, true);
});

test("section support drawings become non-spatial templates instead of map geometry", () => {
  const extraction = {
    normalizedEvidence: {
      geometryCandidates: [{
        id: "section-member-1",
        contentHash: "doc-a",
        pageNumber: 2,
        vectorPathIndex: 0,
        classification: "section",
        closed: false,
        commands: [{ op: "M", x: 10, y: 10 }, { op: "L", x: 30, y: 50 }],
        boundsPt: { minX: 10, minY: 10, maxX: 30, maxY: 50 },
        confidence: 0.8
      }]
    },
    pages: [{
      pageNumber: 2,
      metadata: { scaleDenominator: 100 },
      text: { items: [{ text: "Support frame SUP 12", xPt: 20, yPt: 30 }] },
      vector: { paths: [{ commands: [{ op: "M", x: 10, y: 10 }, { op: "L", x: 30, y: 50 }], bounds: { minX: 10, minY: 10, maxX: 30, maxY: 50 } }] }
    }]
  };
  enrichPlanningRideStructureEvidence(extraction);
  assert.equal(extraction.normalizedEvidence.geometryCandidates.length, 0);
  assert.equal(extraction.normalizedEvidence.rideStructureTemplates.length, 1);
  const template = extraction.normalizedEvidence.rideStructureTemplates[0];
  assert.equal(template.coordinateSpace, "pdf-template-space");
  assert.equal(template.spatialAuthorityEligible, false);
  assert.equal(template.worldGeometryAuthority, false);
  assert.equal(template.linkageRequired, true);
  assert.equal(template.supportCode, "SUP-12");
});

test("plan-view support and sound tunnel geometry receive explicit ride structure kinds", () => {
  const extraction = {
    normalizedEvidence: {
      geometryCandidates: [
        candidate("support-plan", 0, false, { minX: 10, minY: 10, maxX: 20, maxY: 20 }),
        candidate("sound-tunnel-plan", 1, true, { minX: 100, minY: 100, maxX: 150, maxY: 140 })
      ]
    },
    pages: [{
      pageNumber: 1,
      metadata: { scaleDenominator: 200 },
      text: { items: [
        { text: "Support column SUP 8 height 7.5m", xPt: 16, yPt: 16 },
        { text: "Sound tunnel height 5m", xPt: 120, yPt: 115 }
      ] },
      vector: { paths: [{ commands: [] }, { commands: [] }] }
    }]
  };
  enrichPlanningRideStructureEvidence(extraction);
  const support = extraction.normalizedEvidence.geometryCandidates.find((entry) => entry.id === "support-plan");
  const tunnel = extraction.normalizedEvidence.geometryCandidates.find((entry) => entry.id === "sound-tunnel-plan");
  assert.equal(support.kind, "ride_support");
  assert.equal(support.tags["ride_structure:type"], "support_column");
  assert.equal(support.heightM, 7.5);
  assert.equal(tunnel.kind, "structure");
  assert.equal(tunnel.tags["ride_structure:type"], "sound_tunnel");
  assert.equal(tunnel.tags["ride_structure:sound_tunnel"], "yes");
  assert.equal(tunnel.heightM, 5);
});

test("authoritative support with explicit height reconstructs while missing vertical evidence defers", () => {
  const track = rideTrack("ride-1", [[0, 0], [20, 0]]);
  const support = authoritativeFeature({
    id: "support-1",
    kind: "ride_support",
    subtype: "support_column",
    localGeometry: { type: "Point", coordinates: [5, 2] },
    tags: { "ride_structure:type": "support_column" },
    vertical: { heightM: 8 }
  });
  const missing = authoritativeFeature({
    id: "support-2",
    kind: "ride_support",
    subtype: "support_column",
    localGeometry: { type: "Point", coordinates: [10, 2] },
    tags: { "ride_structure:type": "support_column" }
  });
  const model = reconstructRideStructures3d({ features: [track, support, missing] }, {});
  assert.equal(model.structures.length, 1);
  assert.equal(model.structures[0].id, "ride-structure:support-1");
  assert.equal(model.structures[0].members[0].to.dyM, 8);
  assert.ok(model.deferred.some((entry) => entry.featureId === "support-2" && entry.reason === "support-vertical-evidence-missing"));
});

test("same-page multi-path support detail becomes one traced design template", () => {
  const track = rideTrack("ride-1", [[0, 0], [20, 0]]);
  const support = authoritativeFeature({
    id: "support-frame-12",
    kind: "ride_support",
    subtype: "support_frame",
    localGeometry: { type: "LineString", coordinates: [[8, -2], [8, 2]] },
    tags: { "ride_structure:type": "support_frame", "ride_structure:support_code": "SUP-12" }
  });
  const templateBase = {
    contentHash: "support-details",
    pageNumber: 3,
    classification: "section",
    component: "support_frame",
    supportCode: "SUP-12",
    scaleDenominator: 100,
    boundsPt: { minX: 0, minY: 0, maxX: 40, maxY: 40 },
    planningTemporal: { state: "current", confidence: 0.99 },
    templateAuthorityEligible: true,
    worldGeometryAuthority: false
  };
  const templates = [
    { ...templateBase, id: "member-a", commands: [{ op: "M", x: 10, y: 0 }, { op: "L", x: 10, y: 30 }] },
    { ...templateBase, id: "member-b", commands: [{ op: "M", x: 10, y: 30 }, { op: "L", x: 30, y: 0 }] }
  ];
  const model = reconstructRideStructures3d({ features: [track, support] }, {
    planningAuthorityEvidenceData: { rideStructureTemplates: templates }
  });
  assert.equal(model.deferred.filter((entry) => entry.featureId === support.id).length, 0);
  assert.equal(model.structures.length, 1);
  assert.equal(model.structures[0].templateLink.accepted, true);
  assert.deepEqual(model.structures[0].templateLink.sourceTemplateIds, ["member-a", "member-b"]);
  assert.ok(model.structures[0].members.length >= 2);
});

test("same support code on two current detail pages fails closed as ambiguous", () => {
  const track = rideTrack("ride-1", [[0, 0], [20, 0]]);
  const support = authoritativeFeature({
    id: "support-frame-12",
    kind: "ride_support",
    subtype: "support_frame",
    localGeometry: { type: "LineString", coordinates: [[8, -2], [8, 2]] },
    tags: { "ride_structure:type": "support_frame", "ride_structure:support_code": "SUP-12" }
  });
  const template = (pageNumber) => ({
    id: `detail-${pageNumber}`,
    contentHash: "support-details",
    pageNumber,
    component: "support_frame",
    supportCode: "SUP-12",
    scaleDenominator: 100,
    boundsPt: { minX: 0, minY: 0, maxX: 40, maxY: 40 },
    commands: [{ op: "M", x: 10, y: 0 }, { op: "L", x: 10, y: 30 }],
    planningTemporal: { state: "current", confidence: 0.99 },
    templateAuthorityEligible: true,
    worldGeometryAuthority: false
  });
  const model = reconstructRideStructures3d({ features: [track, support] }, {
    planningAuthorityEvidenceData: { rideStructureTemplates: [template(3), template(4)] }
  });
  assert.equal(model.structures.length, 0);
  assert.ok(model.deferred.some((entry) => entry.reason === "support-template-ambiguous"));
});

test("sound tunnel reconstructs as a built enclosure even when one coarse track segment crosses it", () => {
  const track = rideTrack("ride-1", [[0, 0], [20, 0]], 15);
  const tunnel = authoritativeFeature({
    id: "sound-enclosure-1",
    kind: "structure",
    subtype: "sound_tunnel",
    localGeometry: { type: "Polygon", coordinates: [[[5, -3], [15, -3], [15, 3], [5, 3], [5, -3]]] },
    tags: { "ride_structure:type": "sound_tunnel", "ride_structure:sound_tunnel": "yes" },
    vertical: { heightM: 7 }
  });
  const model = reconstructRideStructures3d({ features: [track, tunnel] }, {});
  assert.equal(model.structures.length, 1);
  const enclosure = model.structures[0];
  assert.equal(enclosure.kind, "enclosure");
  assert.equal(enclosure.subtype, "sound_tunnel");
  assert.equal(enclosure.terrainExcavation, false);
  assert.equal(enclosure.terrainGeometryMutable, false);
  assert.equal(enclosure.portals.length, 2);
  assert.deepEqual(enclosure.portals.map((portal) => Math.round(portal.x)).sort((a, b) => a - b), [5, 15]);
  assert.ok(enclosure.portals.every((portal) => portal.elevationM === 15));
});

test("ambiguous nearby ride association fails closed", () => {
  const feature = authoritativeFeature({
    id: "support-x",
    kind: "ride_support",
    localGeometry: { type: "Point", coordinates: [5, 2] },
    tags: { "ride_structure:type": "support_column" }
  });
  const result = associateStructureToRide(feature, [
    rideTrack("ride-a", [[0, 0], [10, 0]]),
    rideTrack("ride-b", [[0, 4], [10, 4]])
  ]);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "ambiguous-ride-association");
});

test("sound tunnel renderer preserves the complete phase-1 terrain set and never clears at or below terrain", () => {
  const track = rideTrack("ride-1", [[0, 0], [20, 0]], 15);
  const tunnel = authoritativeFeature({
    id: "sound-enclosure-1",
    kind: "structure",
    subtype: "sound_tunnel",
    localGeometry: { type: "Polygon", coordinates: [[[5, -3], [15, -3], [15, 3], [5, 3], [5, -3]]] },
    tags: { "ride_structure:type": "sound_tunnel" },
    vertical: { heightM: 7 }
  });
  const map = { features: [track, tunnel] };
  const model = reconstructRideStructures3d(map, {});
  const compilation = terrainCompilation();
  const phaseOneBefore = phaseOneOps(compilation);
  const render = renderRideStructures3d({ compilation, rideStructures: model, map });
  assert.equal(render.terrainGeometryChanged, false);
  assert.equal(render.terrainElevationChanged, false);
  assert.deepEqual(phaseOneOps(compilation), phaseOneBefore);
  const terrainViolations = compilation.chunks.flatMap((chunk) => chunk.o || [])
    .filter((op) => op[0] === 8.3 && op[2] <= 10);
  assert.equal(terrainViolations.length, 0);
  assert.ok(render.enclosureShellVoxels > 0);
  assert.ok(render.portalClearanceVoxels > 0);
});

test("proposed or otherwise non-authoritative ride structures are ignored", () => {
  const track = rideTrack("ride-1", [[0, 0], [20, 0]]);
  const proposed = {
    id: "proposed-support",
    kind: "ride_support",
    localGeometry: { type: "Point", coordinates: [5, 2] },
    tags: { "ride_structure:type": "support_column" },
    vertical: { heightM: 8 },
    authority: { rank: 120, worldGeometryAuthority: false, layer: "planning-proposed" }
  };
  const model = reconstructRideStructures3d({ features: [track, proposed] }, {});
  assert.equal(model.structures.length, 0);
  assert.equal(model.summary.authoritativeStructuralFeatures, 0);
});

function candidate(id, vectorPathIndex, closed, boundsPt) {
  return {
    id,
    contentHash: "plan-doc",
    pageNumber: 1,
    vectorPathIndex,
    classification: "ride_layout",
    closed,
    boundsPt,
    commands: [],
    confidence: 0.75
  };
}

function authoritativeFeature(value) {
  return {
    ...value,
    authority: { rank: 360, layer: "planning-current-authority", worldGeometryAuthority: true, ...(value.authority || {}) },
    confidence: value.confidence ?? 0.95,
    source: value.source || { provider: "planning", contentHash: "current-doc", pageNumber: 1 }
  };
}

function rideTrack(id, coordinates, elevationM = 12) {
  return {
    id,
    kind: "ride_track",
    name: id,
    localGeometry: { type: "LineString", coordinates },
    rideProfile: { samples: coordinates.map(([x, z]) => ({ x, z, elevationM })) },
    authority: { rank: 360, layer: "planning-current-authority", worldGeometryAuthority: true }
  };
}

function terrainCompilation() {
  return {
    palette: ["minecraft:grass_block"],
    chunks: [{ x: 0, z: 0, o: [[1, 0, 10, -8, 20, 10, 8, 0]] }],
    signs: [],
    stats: {},
    meta: {
      bounds: { minX: 0, minZ: -8, maxX: 20, maxZ: 8, width: 21, height: 17 },
      elevationDatumM: 0,
      baseY: 0
    }
  };
}

function phaseOneOps(compilation) {
  return (compilation.chunks || [])
    .flatMap((chunk) => chunk.o || [])
    .filter((op) => op[0] === 1)
    .map((op) => JSON.stringify(op))
    .sort();
}
