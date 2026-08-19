#!/usr/bin/env node
import http from "node:http";
import path from "node:path";
import { createReadStream } from "node:fs";
import { access, mkdir, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { generateBboxWorld, parseBboxText } from "../scripts/generate-bbox-world.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const workspace = path.resolve(process.env.VOXEL_APP_WORKSPACE || ".voxel-app");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const jobs = new Map();

await mkdir(workspace, { recursive: true });

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, {
        ok: true,
        profile: "stable",
        planning: "disabled",
        buildingModes: ["markers", "shells"]
      });
    }

    if (request.method === "GET" && url.pathname === "/api/geocode") {
      const query = String(url.searchParams.get("q") || "").trim();
      if (query.length < 3) return json(response, 400, { error: "Enter at least 3 characters." });
      const endpoint = new URL("https://nominatim.openstreetmap.org/search");
      endpoint.searchParams.set("q", query);
      endpoint.searchParams.set("format", "jsonv2");
      endpoint.searchParams.set("limit", "6");
      endpoint.searchParams.set("addressdetails", "1");
      endpoint.searchParams.set("polygon_geojson", "0");
      const contact = process.env.TPMAP_CONTACT || "https://github.com/CyanGdEv/Voxel-Mapper";
      const geocodeResponse = await fetch(endpoint, {
        headers: {
          "User-Agent": `VoxelMapperStableApp/0.13 (${contact})`,
          Accept: "application/json"
        }
      });
      if (!geocodeResponse.ok) throw new Error(`Address search failed (${geocodeResponse.status})`);
      const results = await geocodeResponse.json();
      return json(response, 200, {
        results: (results || []).map((item) => ({
          placeId: item.place_id,
          displayName: item.display_name,
          type: item.type,
          lat: Number(item.lat),
          lon: Number(item.lon),
          bbox: item.boundingbox?.length === 4 ? {
            south: Number(item.boundingbox[0]),
            north: Number(item.boundingbox[1]),
            west: Number(item.boundingbox[2]),
            east: Number(item.boundingbox[3])
          } : null
        })).filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lon))
      });
    }

    if (request.method === "POST" && url.pathname === "/api/generate") {
      if ([...jobs.values()].some((job) => job.status === "running" || job.status === "queued")) {
        return json(response, 429, { error: "A world is already generating. Wait for it to finish before starting another." });
      }
      const body = await readJsonBody(request, 64 * 1024);
      const bboxObject = parseBboxText(body.bbox);
      const bbox = [bboxObject.south, bboxObject.west, bboxObject.north, bboxObject.east].join(",");
      const buildings3d = body.buildings3d === true;
      const id = makeJobId();
      const root = path.join(workspace, "jobs", id);
      const out = path.join(root, "out");
      const cache = path.join(workspace, "cache");
      const downloadDir = path.join(root, "downloads");
      await Promise.all([mkdir(out, { recursive: true }), mkdir(cache, { recursive: true }), mkdir(downloadDir, { recursive: true })]);

      const job = {
        id,
        status: "queued",
        bbox,
        buildings3d,
        buildingMode: buildings3d ? "shells" : "markers",
        planning: "disabled",
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        progress: "Queued",
        messages: ["Queued"],
        download: null,
        summary: null,
        error: null
      };
      jobs.set(id, job);
      queueMicrotask(() => runJob(job, { out, cache, downloadDir }));
      return json(response, 202, publicJob(job));
    }

    const statusMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)$/i);
    if (request.method === "GET" && statusMatch) {
      const job = jobs.get(statusMatch[1]);
      if (!job) return json(response, 404, { error: "Generation job not found." });
      return json(response, 200, publicJob(job));
    }

    const downloadMatch = url.pathname.match(/^\/api\/jobs\/([a-z0-9-]+)\/download$/i);
    if (request.method === "GET" && downloadMatch) {
      const job = jobs.get(downloadMatch[1]);
      if (!job || job.status !== "complete" || !job.download?.path) {
        return json(response, 404, { error: "World download is not ready." });
      }
      await access(job.download.path);
      const details = await stat(job.download.path);
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": details.size,
        "Content-Disposition": `attachment; filename="${safeDownloadName(job.download.name)}"`,
        "Cache-Control": "private, no-store"
      });
      return createReadStream(job.download.path).pipe(response);
    }

    if (request.method === "GET") return serveStatic(url.pathname, response);
    json(response, 404, { error: "Not found." });
  } catch (error) {
    console.error(error?.stack || error);
    if (!response.headersSent) json(response, 500, { error: error?.message || "Unexpected server error." });
    else response.end();
  }
});

async function runJob(job, paths) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  try {
    const generated = await generateBboxWorld({
      bbox: job.bbox,
      out: paths.out,
      cache: paths.cache,
      authority: path.join(paths.out, "planning-disabled.json"),
      downloadDir: paths.downloadDir,
      stable: true,
      buildings: job.buildingMode
    }, (message) => {
      job.progress = String(message);
      job.messages.push(job.progress);
      if (job.messages.length > 40) job.messages.shift();
      console.log(`[${job.id}] ${job.progress}`);
    });
    const worldPath = generated.summary.generatedWorld;
    job.download = { path: worldPath, name: path.basename(worldPath) };
    job.summary = {
      chunks: generated.summary.worldChunks,
      validation: generated.summary.worldValidation,
      confidence: generated.summary.confidence,
      grade: generated.summary.grade,
      featureProfile: generated.summary.featureProfile
    };
    job.status = "complete";
    job.progress = "World ready to download";
    job.messages.push(job.progress);
    job.completedAt = new Date().toISOString();
  } catch (error) {
    job.status = "failed";
    job.error = error?.message || String(error);
    job.progress = "Generation failed";
    job.messages.push(`${job.progress}: ${job.error}`);
    job.completedAt = new Date().toISOString();
    console.error(`[${job.id}]`, error?.stack || error);
  }
}

async function serveStatic(requestPath, response) {
  const pathname = requestPath === "/" ? "/index.html" : requestPath;
  const relative = pathname.replace(/^\/+/, "");
  const filename = path.resolve(publicDir, relative);
  if (!filename.startsWith(`${path.resolve(publicDir)}${path.sep}`) && filename !== path.join(path.resolve(publicDir), "index.html")) {
    return json(response, 403, { error: "Forbidden." });
  }
  try {
    const details = await stat(filename);
    if (!details.isFile()) throw new Error("not-file");
    response.writeHead(200, {
      "Content-Type": mimeType(filename),
      "Content-Length": details.size,
      "Cache-Control": filename.endsWith("index.html") ? "no-cache" : "public, max-age=3600"
    });
    createReadStream(filename).pipe(response);
  } catch {
    const index = path.join(publicDir, "index.html");
    const details = await stat(index);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": details.size, "Cache-Control": "no-cache" });
    createReadStream(index).pipe(response);
  }
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    bbox: job.bbox,
    buildings3d: job.buildings3d,
    buildingMode: job.buildingMode,
    planning: job.planning,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    progress: job.progress,
    messages: [...job.messages],
    downloadUrl: job.status === "complete" ? `/api/jobs/${job.id}/download` : null,
    summary: job.summary,
    error: job.error
  };
}

async function readJsonBody(request, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function json(response, status, value) {
  const payload = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store"
  });
  response.end(payload);
}

function makeJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function safeDownloadName(value) {
  return String(value || "voxel-mapper-world.mcworld").replace(/[^a-zA-Z0-9._ -]+/g, "-");
}

function mimeType(filename) {
  if (filename.endsWith(".html")) return "text/html; charset=utf-8";
  if (filename.endsWith(".css")) return "text/css; charset=utf-8";
  if (filename.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filename.endsWith(".svg")) return "image/svg+xml";
  if (filename.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

server.listen(port, host, () => {
  console.log(`Voxel Mapper Stable App: http://${host}:${port}`);
  console.log("Planning data is disabled in this app profile.");
});
