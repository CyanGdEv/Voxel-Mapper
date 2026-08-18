#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MIN_NAMED_RIDE_VERTICAL_COVERAGE = 0.9;

export function parseRidePlazaArgs(argv) {
  const result = {
    root: "acceptance-download",
    report: "ride-plaza-production-report.json",
    markdown: "RIDE_PLAZA_PRODUCTION.md"
  };
  const args = [...argv];
  while (args.length) {
    const token = args.shift();
    if (!["--root", "--report", "--markdown"].includes(token)) {
      throw new Error(`Unknown option: ${token}`);
    }
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
    if (token === "--root") result.root = value;
    else if (token === "--report") result.report = value;
    else if (token === "--markdown") result.markdown = value;
  }
  return result;
}

export async function validateRidePlazaProduction(options) {
  const root = path.resolve(options.root);
  const files = await walk(root);
  const evidencePath = requireNamed(files, "evidence.json");
  const fusionPath = requireNamed(files, "planning-authority-fusion.json");
  const evidence = await readJson(evidencePath);
  const fusion = await readJson(fusionPath);
  const failures = [];
  const warnings = [];
  const pass = (condition, message) => {
    if (!condition) failures.push(message);
  };

  const rideProfiles = evidence.rideProfiles || {};
  const rideTotals = rideProfiles.totals || {};
  const namedRides = Array.isArray(rideProfiles.rides)
    ? rideProfiles.rides.filter((ride) => typeof ride?.name === "string" && ride.name.trim())
    : [];
  const twoDimensionalRides = namedRides.filter((ride) =>
    ride.status === "2d-only" || Number(ride.verticalCoverage || 0) <= 0
  );
  const incompleteVerticalRides = namedRides.filter((ride) =>
    Number(ride.verticalCoverage || 0) < MIN_NAMED_RIDE_VERTICAL_COVERAGE
  );
  const profiledTrackFeatures = Number(rideTotals.profiledTrackFeatures || 0);
  const verticalCoverage = Number(rideTotals.verticalCoverage || 0);

  if (namedRides.length) {
    pass(profiledTrackFeatures > 0,
      `Named rides exist (${namedRides.length}) but zero ride_track features have a 3D profile`);
    pass(twoDimensionalRides.length === 0,
      `${twoDimensionalRides.length}/${namedRides.length} named rides are still 2D-only: ${names(twoDimensionalRides)}`);
    pass(incompleteVerticalRides.length === 0,
      `${incompleteVerticalRides.length}/${namedRides.length} named rides have <${Math.round(MIN_NAMED_RIDE_VERTICAL_COVERAGE * 100)}% vertical coverage: ${names(incompleteVerticalRides)}`);
    pass(verticalCoverage >= MIN_NAMED_RIDE_VERTICAL_COVERAGE,
      `Overall ride vertical coverage is ${(verticalCoverage * 100).toFixed(1)}%; production requires at least ${Math.round(MIN_NAMED_RIDE_VERTICAL_COVERAGE * 100)}%`);
  }

  const rideStructures = evidence.rideStructures3d || {};
  const structureSummary = rideStructures.summary || {};
  const structureRender = rideStructures.render || {};
  const reconstructedStructures = Number(structureSummary.reconstructedStructures || 0);
  const renderedStructures = Number(structureRender.structures || 0);
  if (namedRides.length) {
    pass(reconstructedStructures > 0,
      "Named rides exist but no authoritative 3D ride structures were reconstructed");
    pass(renderedStructures > 0,
      "Named rides exist but no 3D ride structures were rendered into the world");
  }

  const planningApplications = Number(evidence.source?.planning?.applicationCount || 0);
  const resolutionChanges = Array.isArray(fusion.resolution?.changes) ? fusion.resolution.changes : [];
  const accessGeometryChanges = resolutionChanges.filter((change) =>
    ["path", "road"].includes(change?.featureKind) && change?.attribute === "geometry"
  );
  const accessMaterialChanges = resolutionChanges.filter((change) =>
    ["path", "road"].includes(change?.featureKind) && change?.attribute === "material"
  );
  const rideGeometryChanges = resolutionChanges.filter((change) =>
    change?.featureKind === "ride_track" && change?.attribute === "geometry"
  );
  const surfacePaint = evidence.planningAuthority?.surfacePaint || fusion.surfacePaint || {};
  const surfaceRender = surfacePaint.render || {};
  const renderedSurfaceFeatures = Number(surfaceRender.renderedFeatures || 0);
  const renderedSurfaceCells = Number(surfaceRender.renderedCellWrites || 0);

  if (planningApplications > 0) {
    pass(accessGeometryChanges.length > 0,
      `Planning found ${planningApplications} applications but applied no path/road geometry changes`);
    if (accessMaterialChanges.length > 0) {
      pass(renderedSurfaceFeatures > 0 && renderedSurfaceCells > 0,
        `Planning resolved ${accessMaterialChanges.length} path/road surface-material attributes but rendered zero planning surface cells`);
    }
    if (namedRides.length) {
      pass(rideGeometryChanges.length > 0,
        "Planning data was available for a park with named rides but no planning ride geometry reached final authority");
    }
  } else {
    warnings.push("No planning applications were present, so planning-derived access/plaza assertions were not applicable");
  }

  const report = {
    schemaVersion: 1,
    status: failures.length ? "failed" : "passed",
    generatedAt: new Date().toISOString(),
    thresholds: {
      minNamedRideVerticalCoverage: MIN_NAMED_RIDE_VERTICAL_COVERAGE
    },
    rides: {
      namedRides: namedRides.length,
      trackFeatures: Number(rideTotals.trackFeatures || 0),
      profiledTrackFeatures,
      overallVerticalCoverage: verticalCoverage,
      twoDimensional: twoDimensionalRides.map(rideSummary),
      incompleteVertical: incompleteVerticalRides.map(rideSummary),
      reconstructedStructures,
      renderedStructures,
      supportStructures: Number(structureRender.supportStructures || 0),
      catwalks: Number(structureSummary.catwalks || 0),
      platforms: Number(structureSummary.platforms || 0),
      soundTunnels: Number(structureSummary.soundTunnels || 0)
    },
    planningAccess: {
      applications: planningApplications,
      geometryChanges: accessGeometryChanges.length,
      materialChanges: accessMaterialChanges.length,
      rideGeometryChanges: rideGeometryChanges.length,
      renderedSurfaceFeatures,
      renderedSurfaceCells
    },
    failures,
    warnings
  };

  await writeFile(path.resolve(options.report), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.resolve(options.markdown), buildMarkdown(report));
  return report;
}

function rideSummary(ride) {
  return {
    name: ride.name,
    status: ride.status || null,
    verticalCoverage: Number(ride.verticalCoverage || 0),
    featureCount: Array.isArray(ride.featureIds) ? ride.featureIds.length : 0
  };
}

function names(rides) {
  const values = rides.map((ride) => ride.name).filter(Boolean);
  if (values.length <= 8) return values.join(", ");
  return `${values.slice(0, 8).join(", ")} (+${values.length - 8} more)`;
}

function buildMarkdown(report) {
  const lines = [
    `# Ride + plaza production gate: ${report.status.toUpperCase()}`,
    "",
    `- Named rides: **${report.rides.namedRides}**`,
    `- 3D-profiled ride_track features: **${report.rides.profiledTrackFeatures}/${report.rides.trackFeatures}**`,
    `- Overall ride vertical coverage: **${(report.rides.overallVerticalCoverage * 100).toFixed(1)}%**`,
    `- Named rides still 2D-only: **${report.rides.twoDimensional.length}**`,
    `- Reconstructed/rendered ride structures: **${report.rides.reconstructedStructures}/${report.rides.renderedStructures}**`,
    `- Planning access geometry changes: **${report.planningAccess.geometryChanges}**`,
    `- Planning access surface-material changes: **${report.planningAccess.materialChanges}**`,
    `- Planning surface features/cells rendered: **${report.planningAccess.renderedSurfaceFeatures}/${report.planningAccess.renderedSurfaceCells}**`,
    `- Planning ride geometry changes: **${report.planningAccess.rideGeometryChanges}**`,
    ""
  ];
  if (report.failures.length) {
    lines.push("## Failures", "", ...report.failures.map((message) => `- ${message}`), "");
  }
  if (report.warnings.length) {
    lines.push("## Warnings", "", ...report.warnings.map((message) => `- ${message}`), "");
  }
  return `${lines.join("\n")}\n`;
}

async function walk(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) files.push(filename);
    }
  }
  await visit(root);
  return files;
}

function requireNamed(files, basename) {
  const matches = files.filter((filename) => path.basename(filename) === basename);
  if (!matches.length) throw new Error(`Required production evidence is missing: ${basename}`);
  const preferred = matches.find((filename) => filename.includes(`${path.sep}preparation${path.sep}`));
  return preferred || matches[0];
}

const readJson = async (filename) => JSON.parse(await readFile(filename, "utf8"));

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    const options = parseRidePlazaArgs(process.argv.slice(2));
    const report = await validateRidePlazaProduction(options);
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "passed") process.exitCode = 1;
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
