# Voxel Mapper Stable App

The stable app is the user-facing bbox-to-Bedrock workflow.

## Stable profile

The stable profile keeps the existing public-data world pipeline but disables planning-data acquisition and planning-authority handoff. The planning subsystem remains in the repository for research/development builds; it is simply not used by stable app jobs.

Stable generation currently keeps:

- OpenStreetMap bounded map acquisition
- automatic terrain/elevation selection
- paths, route widths, bridges and surface fidelity from non-planning sources
- trees, vegetation, water and terrain detail
- ride geometry/evidence available from non-planning sources
- Bedrock LevelDB world compilation and `.mcworld` validation/export

Planning applications, planning-document scraping, planning geometry overrides, planning materials and planning object reconstruction are disabled for the stable app profile.

## 3D buildings

The app exposes one toggle:

- **Off** → `buildings=markers` for the fastest/stablest footprint representation.
- **On** → `buildings=shells` to build available 3D building shells/roofs from the existing building/elevation pipeline.

The research bbox workflow preserves its existing `shells` default.

## Run the app

```bash
npm ci
npm run app
```

Then open the address printed by the server (default `http://127.0.0.1:4173`). Set `PORT` or `HOST` to change the bind address. `TPMAP_CONTACT` may be set to an email/project URL for the app's identifying public-data User-Agent.

## User workflow

1. Search an address/place or move directly on the map.
2. Draw/edit the bounding box rectangle, or type south/west/north/east coordinates.
3. Optionally enable **3D buildings**.
4. Click **Generate Bedrock world**.
5. The UI polls generation progress.
6. When complete, click **Download .mcworld** from inside the app.

Only one generation runs at a time in this first stable server implementation. Each job has an isolated output/download directory while source cache data is shared between jobs.

## HTTP API

- `GET /api/health`
- `GET /api/geocode?q=...`
- `POST /api/generate` with `{ "bbox": "S,W,N,E", "buildings3d": false }`
- `GET /api/jobs/:id`
- `GET /api/jobs/:id/download`

The generation endpoint always forces the stable profile; callers cannot turn planning back on through the app API.
