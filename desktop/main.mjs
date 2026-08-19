import { app, BrowserWindow, dialog } from "electron";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ID = "dev.cyangdev.voxelmapper";
let backend = null;
let mainWindow = null;
let backendUrl = null;
let quitting = false;

app.setAppUserModelId(APP_ID);

app.whenReady().then(async () => {
  try {
    const port = await findFreePort();
    backendUrl = `http://127.0.0.1:${port}`;
    backend = startBackend(port);
    await waitForHealth(`${backendUrl}/api/health`, 30_000);
    mainWindow = createWindow();
    mainWindow.once("ready-to-show", () => mainWindow?.show());
    await mainWindow.loadURL(backendUrl);
  } catch (error) {
    await dialog.showMessageBox({
      type: "error",
      title: "Voxel Mapper could not start",
      message: "The Voxel Mapper generation service failed to start.",
      detail: error?.stack || error?.message || String(error)
    });
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  stopBackend();
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: "#0a0d12",
    title: "Voxel Mapper",
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0f141b",
      symbolColor: "#f4f7fb",
      height: 44
    },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: false
    }
  });

  // The UI may load OSM/Leaflet assets, but it is not allowed to create a
  // second browser-style application window. World downloads stay in this app
  // and use Electron's standard Windows download behavior.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("closed", () => {
    mainWindow = null;
    if (!quitting) stopBackend();
  });
  return win;
}

function runtimeRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "runtime")
    : path.resolve(__dirname, "..");
}

function nodeBinary() {
  if (app.isPackaged) return path.join(runtimeRoot(), "node.exe");
  return process.env.VOXEL_NODE || "node";
}

function startBackend(port) {
  const root = runtimeRoot();
  const server = path.join(root, "app", "server.mjs");
  const workspace = path.join(app.getPath("userData"), "workspace");
  const child = spawn(nodeBinary(), [server], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      VOXEL_APP_WORKSPACE: workspace,
      TPMAP_CONTACT: process.env.TPMAP_CONTACT || "https://github.com/CyanGdEv/Voxel-Mapper"
    }
  });

  child.stdout?.on("data", (chunk) => console.log(`[generator] ${String(chunk).trimEnd()}`));
  child.stderr?.on("data", (chunk) => console.error(`[generator] ${String(chunk).trimEnd()}`));
  child.on("exit", (code, signal) => {
    if (quitting) return;
    console.error(`Voxel Mapper backend exited unexpectedly (code=${code}, signal=${signal})`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "Generation service stopped",
        message: "Voxel Mapper's local generation service stopped unexpectedly.",
        detail: `Exit code: ${code ?? "unknown"}`
      }).catch(() => {});
    }
  });
  return child;
}

function stopBackend() {
  if (!backend || backend.killed) return;
  try { backend.kill(); } catch {}
  backend = null;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(url, timeoutMs) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) {
        const health = await response.json();
        if (health?.ok && health?.profile === "stable" && health?.planning === "disabled") return;
        throw new Error("Backend started without the stable planning-disabled profile.");
      }
      lastError = new Error(`Health check returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error("Timed out waiting for the Voxel Mapper backend.");
}
