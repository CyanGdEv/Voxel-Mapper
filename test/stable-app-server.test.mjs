import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("stable app exposes health contract with planning disabled", async () => {
  const port = 47000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ["app/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      VOXEL_APP_WORKSPACE: `.tmp-stable-app-${process.pid}-${port}`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    let response = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (child.exitCode != null) break;
      try {
        response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.ok) break;
      } catch {}
      await sleep(100);
    }
    assert.equal(child.exitCode, null, `app server exited before health check: ${stderr}`);
    assert.ok(response?.ok, `stable app health endpoint did not start: ${stderr}`);
    const health = await response.json();
    assert.equal(health.ok, true);
    assert.equal(health.profile, "stable");
    assert.equal(health.planning, "disabled");
    assert.deepEqual(health.buildingModes, ["markers", "shells"]);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      sleep(1500).then(() => child.kill("SIGKILL"))
    ]);
  }
});
