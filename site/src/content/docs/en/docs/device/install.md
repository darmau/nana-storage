---
title: Install and take over
description: Process photos on your own computer with Docker instead of cloud containers.
sidebar:
  order: 1
---

While on-device processing runs, uploaded photos (thumbnails, previews, fingerprints, faces, video transcoding) are processed **on your own computer** and **no Cloudflare container is started**, so there's no container cost. It uses exactly the same processing code and models as the cloud (the same Dockerfile), so results are identical.

Good for: importing thousands or tens of thousands of photos — or simply leaving it on so a computer at home does all the processing.

## Install

You need Docker Desktop. Give it as much CPU and memory as you can under Settings › Resources; each parallel task can use 1–2 GB of memory.

```bash
cd apps/device
docker compose up -d --build
```

If you turned off face recognition in the cloud (`NANA_FACES=off`), build with the same value:

```bash
NANA_FACES=off docker compose up -d --build
```

## Sign in and take over

Open <http://localhost:7878>:

1. Settings (the gear at the top right) opens the first time: enter the library address (e.g. `https://photos.example.com`), a device name and the number of parallel tasks (default: 3/4 of the CPUs Docker has; lower it if memory is tight).
2. Click Log in, open the link it shows in your browser and sign in the way you normally do (Cloudflare Access email code). The credentials are kept in a Docker volume; the UI tells you when they expire.
3. Once signed in it takes over automatically. Upload in the browser as usual and queued jobs are processed here. Settings › Background processing in the library shows which device is handling them.

On startup it runs a self-check (models readable, vips / exiftool / ffmpeg available) and only takes over if it passes.

## Stopping

- `docker compose stop`, or click "hand back to the cloud" in the UI. Jobs in progress go back to the server and cloud containers take over again.
- If the computer shuts down or goes offline, the server switches back to cloud containers after about **2 minutes**; jobs left over from the takeover are re-sent by the hourly cron.
- After 5 failures in a row it hands back to the cloud automatically (most likely a local problem).

## How it works

- **Identity**: it signs in with your own Access login (`cloudflared`), just like your browser. The server has no extra account, token or back door for it.
- **Takeover**: each job claim renews a 2-minute lease. While the lease is valid the server's queue consumer doesn't start containers, and jobs wait in the database for this computer. Idle, it polls every 10 seconds — about 8,640 requests a day if left on, a negligible cost.
- **Processing**: download the original → process locally → upload the thumbnail, preview and H.264 preview to the locations the server specifies → the server writes the database with **exactly the same** code as the container path. If the photo changed meanwhile (rotated, say), the server sees the result is stale and processes it again, so nothing wrong is written.
- **Failures**: like containers, each job is tried at most 3 times.
- **Circuit breaker**: device jobs are subject to the [breaker](../../costs/) too (the same photo processed over and over); while it's tripped the device can't take over. Device processing time doesn't count toward container cost.

## Architecture differences

Cloudflare's image is linux/amd64; on an Apple Silicon Mac it's arm64. Perceptual hashes match exactly and CLIP vectors agree to a cosine of about 0.99 (above every threshold), so mixing photos processed in either place is fine.

## Upgrading

After each library update, rebuild in `apps/device`:

```bash
docker compose up -d --build
```

This matters especially for releases whose CHANGELOG says on-device users need to act: otherwise new features (cropping or blurring, say) fail on the device (nothing wrong is written).
