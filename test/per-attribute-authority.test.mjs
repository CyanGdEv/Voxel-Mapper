import test from "node:test";
import assert from "node:assert/strict";
import { applyOfficialSourceAuthority } from "../src/lib/official-source-authority.mjs";
import { materializeEvidenceWinners } from "../src/lib/evidence-graph.mjs";

function polygon(x0 = 0, z0 = 0, size = 10) {
  return {
    type: "Polygon",
    coordinates: [[
      [x0, z0], [x0 + size, z0], [x0 + size, z0 + size],
      [x0, z0 + size], [x0, z0]
    ]]
  };
}

test("official geometry removal preserves the OSM feature as lower-authority evidence", () => {
  const geometry = polygon();
  const official = {
    id: "public:os-building:1",
    name: "Station Building",
    kind: "building",
    subtype: "building",
    geometry,
    localGeometry: geometry,
    tags: { building: "yes" },
    source: { provider: "OS Building Features", dataset: "OS Building Features" },
    authority: { layer: "licensed-public", rank: 200, geometryLocked: false },
    verification: { plan: "licensed-public-observation", vertical: "unknown" },
    vertical: { heightM: null, minHeightM: 0, elevationM: null, explicit: false }
  };
  const osm = {
    id: "osm:way:123",
    name: "Station Building",
    kind: "building",
    subtype: "building",
    geometry,
    localGeometry: geometry,
    tags: { building: "yes", "building:material": "brick" },
    source: { provider: "OpenStreetMap", elementId: 123 },
    authority: { layer: "osm", rank: 100, geometryLocked: false },
    verification: { plan: "public-map", vertical: "unknown" },
    vertical: { heightM: null, minHeightM: 0, elevationM: null, explicit: false }
  };
  const map = { features: [osm, official], sourceFusion: {} };
  const summary = applyOfficialSourceAuthority(map, { sourceFusionToleranceM: 3 });
  assert.equal(summary.osmFallbackFeaturesRemoved, 1);
  assert.equal(summary.preservedOsmFallbackEvidence, 1);
  assert.equal(map.features.length, 1);
  assert.equal(map.features[0].id, official.id);
  assert.equal(map.features[0].evidenceHistory[0].featureId, osm.id);
  assert.equal(map.features[0].evidenceHistory[0].tags["building:material"], "brick");
});

test("low-authority evidence may fill a missing material attribute", () => {
  const feature = {
    id: "public:building:1",
    kind: "building",
    tags: {},
    vertical: { heightM: null, minHeightM: 0, elevationM: null, explicit: false },
    evidenceGraph: {
      attributes: {
        material: {
          conflict: false,
          winner: {
            value: "brick",
            source: "OpenStreetMap",
            sourceRef: "123",
            method: "feature-material",
            authorityLayer: "osm",
            authorityRank: 100,
            observedAt: null,
            score: 0.55
          }
        }
      }
    }
  };
  const summary = materializeEvidenceWinners({ features: [feature] });
  assert.equal(feature.tags["building:material"], "brick");
  assert.equal(summary.fallbackAttributesApplied, 1);
  assert.equal(feature.attributeAuthority.material.source, "OpenStreetMap");
});

test("low-authority fallback cannot overwrite an existing material attribute", () => {
  const feature = {
    id: "public:building:2",
    kind: "building",
    tags: { "building:material": "stone" },
    vertical: { heightM: null, minHeightM: 0, elevationM: null, explicit: false },
    evidenceGraph: {
      attributes: {
        material: {
          conflict: false,
          winner: {
            value: "brick",
            source: "OpenStreetMap",
            sourceRef: "456",
            method: "feature-material",
            authorityLayer: "osm",
            authorityRank: 100,
            observedAt: null,
            score: 0.55
          }
        }
      }
    }
  };
  const summary = materializeEvidenceWinners({ features: [feature] });
  assert.equal(feature.tags["building:material"], "stone");
  assert.equal(summary.appliedAttributes, 0);
  assert.equal(summary.lowConfidenceDeferred, 1);
});
