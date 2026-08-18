import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateRidePlazaProduction } from "../scripts/validate-ride-plaza-production.mjs";

test("ride and plaza production gate accepts 3D rides plus rendered planning access surfaces", async () => {
  const root = await createFixture({ failing: false });
  try {
    const report = await validateRidePlazaProduction({
      root,
      report: path.join(root, "report.json"),
      markdown: path.join(root, "report.md")
    });
    assert.equal(report.status, "passed");
    assert.equal(report.rides.twoDimensional.length, 0);
    assert.equal(report.planningAccess.renderedSurfaceCells, 240);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ride and plaza production gate rejects the completed-but-2D failure mode", async () => {
  const root = await createFixture({ failing: true });
  try {
    const report = await validateRidePlazaProduction({
      root,
      report: path.join(root, "report.json"),
      markdown: path.join(root, "report.md")
    });
    assert.equal(report.status, "failed");
    const failures = report.failures.join("\n");
    assert.match(failures, /zero ride_track features have a 3D profile/);
    assert.match(failures, /Galactica/);
    assert.match(failures, /no authoritative 3D ride structures/);
    assert.match(failures, /rendered zero planning surface cells/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createFixture({ failing }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "voxel-ride-plaza-gate-"));
  const out = path.join(root, "preparation", "out", "bbox-world");
  await mkdir(out, { recursive: true });

  await json(path.join(out, "evidence.json"), {
    source: {
      planning: { applicationCount: 3 }
    },
    rideProfiles: {
      totals: {
        trackFeatures: 4,
        profiledTrackFeatures: failing ? 0 : 4,
        namedRides: 1,
        verticalCoverage: failing ? 0 : 1
      },
      rides: [{
        name: "Galactica",
        featureIds: ["ride:1", "ride:2", "ride:3", "ride:4"],
        status: failing ? "2d-only" : "verified-3d",
        verticalCoverage: failing ? 0 : 1
      }]
    },
    rideStructures3d: {
      summary: {
        reconstructedStructures: failing ? 0 : 8,
        catwalks: failing ? 0 : 1,
        platforms: failing ? 0 : 1,
        soundTunnels: 0
      },
      render: {
        structures: failing ? 0 : 8,
        supportStructures: failing ? 0 : 7
      }
    },
    planningAuthority: {
      surfacePaint: {
        render: {
          renderedFeatures: failing ? 0 : 2,
          renderedCellWrites: failing ? 0 : 240
        }
      }
    }
  });

  await json(path.join(out, "planning-authority-fusion.json"), {
    resolution: {
      changes: [
        { featureId: "path:1", featureKind: "path", attribute: "geometry" },
        { featureId: "path:1", featureKind: "path", attribute: "material" },
        { featureId: "ride:1", featureKind: "ride_track", attribute: "geometry" }
      ]
    },
    surfacePaint: {
      render: {
        renderedFeatures: failing ? 0 : 2,
        renderedCellWrites: failing ? 0 : 240
      }
    }
  });
  return root;
}

const json = (filename, value) => writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
