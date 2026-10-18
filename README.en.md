# Nana (那时)

English · [简体中文](README.md)

A private photo library, similar to Google Photos, that you deploy to your own Cloudflare account. It is built for exactly one user.

Originals and thumbnails live in your own R2 bucket, and every page and file sits behind Cloudflare Zero Trust. The only third-party service is the map base layer (OpenFreeMap), and it never sees a photo.

## Features

- **Timeline**: grouped by capture date, with a scrubber that jumps to any month. Bursts collapse into one tile. Only rows near the viewport are rendered (about 1,100 DOM nodes at most with 50,000 photos).
- **Upload**: JPEG, HEIC, PNG, RAW and video. A HEIC + MOV pair with the same name becomes a Live Photo, and a RAW + JPEG pair becomes one item. Duplicates are detected by content and skipped.
- **Viewing**: Live Photos play. Videos play the original when the browser can decode HEVC, and an H.264 preview otherwise. You can view EXIF data and download originals.
- **Organizing**: folder tree, albums and favorites, plus a trash that keeps items for 30 days. Multi-select works for batch actions and zip downloads.
- **Editing**: change capture time (with time zone), location and description; rotate, crop and blur out areas (frosted glass; covered faces are left out of People). Only thumbnails and previews change, originals are never modified.
- **Search**: by file name and description, with filters for date, type, camera and favorites.
- **Map**: photos are clustered by location. The base map comes from OpenFreeMap (worldwide, free, kept up to date), and place names follow the UI language.
- **People**: faces are detected and grouped by person, and you can name, merge and correct the groups. This can be turned off; see [License](#license).
- **Similar and duplicate photos**: find duplicates and browse similar photos. "Themes" suggest photos by subject (dogs, cars…), and you choose which ones go into an album.
- **Device processing** (optional): process photos on your own computer with Docker instead of in Cloud containers. It can read originals straight from a local folder, which saves container costs.
- **Also**: Simplified Chinese / English UI, dark mode, and add-to-home-screen (PWA).

## Architecture

```
Browser ──> Cloudflare Access (one-time PIN by email, one allowed address)
              │
              ▼
         Worker: nana-storage
           ├─ Hono API + React frontend (static assets)
           ├─ D1         metadata
           ├─ R2         originals and derived files
           ├─ KV         download manifests, limit settings
           ├─ Queue      background processing jobs
           ├─ Vectorize  vector indexes for similar photos and faces
           ├─ Durable Object: Processor  ──> Container (libvips / exiftool / LibRaw / ffmpeg, no internet)
           ├─ Durable Object: UsageGuard     usage accounting and circuit breaker
           └─ Cron       hourly index catch-up etc., daily trash cleanup
```

There is a single Worker. Each upload goes into a queue. A container then reads the metadata, generates the thumbnail and preview, and transcodes ordinary videos to H.264 (the motion part of a Live Photo is not transcoded). The results are written back to R2 and D1.

## Two design principles

**Security: nobody but the owner can get at the photos.**

- The whole site sits behind Access, and the Worker verifies identity again on every request, static assets included. If the identity configuration is missing, every request is refused.
- R2 has no public access and no presigned URLs. `workers.dev` and preview URLs are disabled.
- Browser caching is `private` only. The CSP allows same-origin resources only. Uploads are checked by file signature, so executable content such as SVG or HTML is rejected.

**Cost: a runaway bill should not be possible.**

- Loops are ruled out by design: no Durable Object alarms, no R2 event notifications, and queue consumers never re-enqueue work themselves.
- The container pool is fixed (4 concurrent by default, at most 32 in the pool). Containers stop when idle, every job has a hard timeout, and each job is attempted at most 3 times.
- `UsageGuard` records daily usage (for display only, not as a limit). It trips, pausing background processing and uploads, when the month's estimated container cost reaches the monthly cap ($10 by default, adjustable in Settings) or when it detects a processing loop. Uploads show an estimated container cost for the batch and suggest device processing for large batches.
- `pnpm check:cost-rules` checks these rules statically and runs in CI.

The full rules are in [CLAUDE.md](CLAUDE.md) (in Chinese).

## Repository layout

```
apps/
  worker/      Worker: API, queue consumer, cron, Durable Objects, D1 migrations (wrangler.jsonc lives here)
  web/         React frontend (Vite, TanStack Router/Query/Virtual, MapLibre)
  processor/   Container image: image and video processing service
  device/      Device processing (optional, runs in Docker on your own computer)
packages/
  shared/      Shared types and every cost-limit constant
scripts/       Cost-rule checks, setup and deploy scripts, end-to-end and browser tests
docs/          Deployment docs
.github/       Workflow that keeps a fork in sync with upstream
```

## Deployment

1. Fork this repository.
2. Run `pnpm run setup` on your own machine. It creates the Cloudflare resources, configures Access and sets the secrets, and you can run it again safely.
3. In the Cloudflare dashboard, connect the Worker to your fork and set the build variable `NANA_DOMAIN`.

The step-by-step guide is in [docs/deploy.en.md](docs/deploy.en.md).

Your domain and resource IDs are never written into repository files, so your fork stays identical to upstream. To update later, click **Sync fork** on GitHub (or enable the included workflow), and Workers Builds migrates the database and deploys the new version.

## Local development

You need Node 24, pnpm 12 and Docker (`wrangler dev` builds and runs the processing container locally).

```bash
pnpm install
cd apps/worker
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply nana-db --local
cd ../web && npx vite build        # the Worker serves the frontend from apps/web/dist
cd ../worker && npx wrangler dev   # http://localhost:8787, signed in with a simulated identity
```

For frontend work you can use the Vite dev server instead: set `APP_ORIGIN=http://localhost:5173` in `.dev.vars`, then run `npx vite` in `apps/web` (`/api` is proxied to 8787).

## Tests

```bash
pnpm run ci                  # cost rules + type check + all unit tests + frontend build (same as CI)
```

These need `wrangler dev` running:

```bash
pnpm e2e                                     # end to end: upload, processing, dedup, zip download
pnpm smoke:processor                         # container only
node scripts/perf/timeline-perf.mjs <dir>    # timeline performance with 50,000 photos (load scripts/perf/seed-50k.sql first)
node scripts/perf/library-ui.mjs <dir>       # folders, albums, trash and other UI flows
node scripts/perf/metadata-ui.mjs <dir>      # metadata editing and search
node scripts/perf/map-ui.mjs <dir>           # map (needs internet access)
```

Browser tests drive your local Chrome in headless mode and save screenshots to the given directory.

## Known limitations

- Safari on iPhone can only upload still images. For a complete Live Photo, export the unmodified original from Photos on a Mac and upload that.
- Videos longer than 5 minutes or larger than 2 GB are not transcoded; only the original is kept (Safari and macOS play it directly).
- The motion part of a Live Photo is not transcoded, so browsers that can't decode HEVC (such as Firefox) show only the still photo.
- Videos can't be rotated yet.
- The RAW pipeline hasn't been tested with real camera files yet.
- The base map comes from OpenFreeMap. It can see which map area you browse (but no photos). If it is down, the map page won't load; nothing else is affected.

## License

[AGPL-3.0](LICENSE). If you offer a modified version to others as a network service, you must make the modified source code available to those users.

The InsightFace model weights used for face recognition are licensed for **non-commercial use only** and are not covered by the AGPL. Set the build variable `NANA_FACES=off` to leave them out entirely. Other third-party components are listed in [NOTICE](NOTICE).

To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md). To report a security issue, see [SECURITY.md](SECURITY.md).
