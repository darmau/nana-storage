---
title: Local originals
description: Skip downloads when the originals are still on this computer or a NAS.
sidebar:
  order: 2
---

For photos uploaded through the web app, if the originals are still on this computer (or a NAS it can reach), mount those folders **read-only** into the container. Processing then reads the local files instead of downloading the originals again.

```bash
cd apps/device
cp compose.override.example.yaml compose.override.yaml
```

Edit `compose.override.yaml` with your own folders (several are fine, all under `/local`):

```yaml
services:
  device:
    volumes:
      - /Users/me/Pictures/Export:/local/export:ro
      - /Volumes/NAS/Photos:/local/nas:ro
```

Then `docker compose up -d --build`. `compose.override.yaml` isn't in the repository, so updates don't overwrite it. Docker Desktop can access `/Users` and `/Volumes` by default.

## How files are matched

- An index is built in the background at startup, recording sizes and names only — **contents aren't read**. The UI shows how many files were indexed. Missing files trigger a rescan at most every 5 minutes, so newly copied files are found too.
- Candidates are matched by size, same-name files first; renamed files work too (e.g. renamed during a Photos export).
- Each candidate is hashed (SHA-256) while being copied to a temporary folder and used only if it matches the hash recorded at upload.
- Before using it, the server also hashes the copy in R2, inside Cloudflare. If a disk read went wrong during upload, the local file is fine but R2's copy is corrupt, and that must be caught.
- The server doesn't hash files over 2 GB (Worker CPU time is limited), so those are always downloaded.
- **Any error at any step falls back to downloading**; a local file never makes a job fail.
