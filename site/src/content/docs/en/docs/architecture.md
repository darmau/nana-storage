---
title: Architecture
description: One Worker, a few Cloudflare storage products and a processing container.
---

```
Browser ──> Cloudflare Access (email one-time PIN, one email only)
             │
             ▼
        Worker: nana-storage
          ├─ Hono API + React frontend (static assets)
          ├─ D1         metadata, jobs, faces, statistics
          ├─ R2         originals, thumbnails, previews
          ├─ KV         download manifests, some settings
          ├─ Queue      background processing jobs
          ├─ Vectorize  vector indexes for similar photos and faces
          ├─ Durable Object: Processor  ──> Container (libvips / exiftool / LibRaw / ffmpeg, no internet)
          ├─ Durable Object: UsageGuard     usage accounting and circuit breaker
          └─ Cron       hourly index catch-up, daily trash purge and statistics
```

## A photo's journey

1. **Upload**: the browser computes each file's SHA-256 locally (exact duplicates are skipped) and uploads it to R2 in 20 MB parts. The first part is checked by its file header; unknown formats are rejected.
2. **Queue**: once every file is in, the item becomes "pending" and a job is queued. The `jobs` table in D1 is the single source of truth; each job is tried at most 3 times.
3. **Process**: a queue consumer takes a container slot from UsageGuard (4 at a time by default) and the Processor hands the original to the container. In one pass it reads metadata, generates a thumbnail and a 3840 px preview (WebP, color profile kept), computes fingerprints (perceptual hash + CLIP vector) and detects faces. Regular videos are also transcoded to H.264.
4. **Write back**: results go to R2 and D1, vectors to Vectorize. The container stops after 30 seconds idle.
5. **Browse**: every byte leaves through the Worker after the identity check, with `Cache-Control: private` only — never the CDN.

With [on-device processing](../device/install/) running, step 3 happens on your own computer instead and no cloud container starts.

## Why this design

- **One Worker**: one deployment, one set of permissions and config. Frontend, API, queue consumer and cron all live in it.
- **Containers for processing**: HEIC, RAW and video need libvips, LibRaw and ffmpeg, which can't run in a Worker. Containers are billed per second and stop when done.
- **Nothing runs on its own**: no Durable Object alarms, no R2 event notifications, the Worker never calls itself. Everything that repeats (cron, polling, retries) has a written upper bound. See [Costs](../costs/).

## Where the code is

| Directory | Contents |
|---|---|
| `apps/worker/` | The Worker: API, queue consumer, cron, Durable Objects, D1 migrations |
| `apps/web/` | React frontend |
| `apps/processor/` | Processing container image (`lib.mjs` is the processing code) |
| `apps/device/` | On-device processing (Docker) |
| `packages/shared/` | Shared types and every cost limit constant |
