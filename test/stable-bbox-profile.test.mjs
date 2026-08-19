import test from "node:test";
import assert from "node:assert/strict";
import { buildBboxWorldOptions, parseGenerateArgs } from "../scripts/generate-bbox-world.mjs";

const bbox = "52.9820,-1.9000,52.9945,-1.8665";

test("stable bbox profile disables planning authority and automatic planning acquisition", async () => {
  const result = await buildBboxWorldOptions({
    bbox,
    out: "out/stable-test",
    cache: ".tpmap-cache",
    authority: "planning-current-authority-evidence.json",
    stable: true,
    buildings: "markers"
  }, async () => true, false);

  assert.equal(result.featureProfile.stable, true);
  assert.equal(result.featureProfile.planning, "disabled");
  assert.equal(result.authority.available, false);
  assert.equal(result.authority.mode, "disabled-stable-profile");
  assert.equal(result.options.planningMode, "off");
  assert.deepEqual(result.options.planning, []);
  assert.equal(result.options.disablePlanItDiscovery, true);
  assert.equal(result.options.planningAuthorityEvidence, undefined);
  assert.equal(result.options.planningAuthorityEvidenceData, undefined);
  assert.equal(typeof result.options.planningAcquirerImpl, "function");
  const disabled = await result.options.planningAcquirerImpl();
  assert.equal(disabled.status, "disabled-stable-profile");
  assert.equal(disabled.applicationCount, 0);
});

test("3D buildings are an explicit stable-profile toggle", async () => {
  const off = await buildBboxWorldOptions({ bbox, out: "out/off", cache: ".cache", stable: true, buildings: "markers" }, async () => false, false);
  const on = await buildBboxWorldOptions({ bbox, out: "out/on", cache: ".cache", stable: true, buildings: "shells" }, async () => false, false);
  assert.equal(off.options.buildings, "markers");
  assert.equal(off.featureProfile.buildings3d, false);
  assert.equal(on.options.buildings, "shells");
  assert.equal(on.featureProfile.buildings3d, true);
});

test("CLI parser accepts stable mode and building mode without changing research defaults", () => {
  const stable = parseGenerateArgs(["--bbox", bbox, "--stable", "--buildings", "shells"]);
  assert.equal(stable.stable, true);
  assert.equal(stable.buildings, "shells");

  const normal = parseGenerateArgs(["--bbox", bbox]);
  assert.equal(normal.stable, false);
  assert.equal(normal.buildings, "markers");
});
