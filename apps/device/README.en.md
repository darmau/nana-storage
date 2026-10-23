# nana-device: process photos on your own computer

English · [简体中文](README.md)

While it runs, uploaded photos are processed on this computer (thumbnails, previews, fingerprints, faces, video transcoding) and **no Cloudflare container is started**. It uses the same processing code as the cloud container (`apps/processor/lib.mjs`, same Dockerfile), so the results are identical.

The local web UI follows your browser language (Simplified Chinese or English); you can change it in Settings.

## Usage

You need Docker Desktop. Give it as much CPU and memory as you can (Settings → Resources); each parallel task can use 1–2 GB of memory.

```bash
cd apps/device
docker compose up -d --build
```

If you turned off face recognition in the cloud (build variable `NANA_FACES=off`), build with the same value here: `NANA_FACES=off docker compose up -d --build`. Otherwise photos processed on this computer get faces and photos processed in the cloud don't.

Open <http://localhost:7878>:

1. In Settings (the gear at the top right; it opens automatically the first time), enter the library address (e.g. `https://photos.example.com`), a device name, and the number of parallel tasks. The default is 3/4 of the CPUs available to Docker; lower it if memory is tight.
2. Click Log in (登录), open the link it shows in your browser, and sign in with your library account (the usual Cloudflare Access login). The credentials are kept in a Docker volume; the UI tells you when they expire.
3. Once signed in, it takes over automatically. Upload photos in the browser as usual, and queued tasks are processed on this computer. The library's Settings → Background processing shows that a device is handling them.

The server queue it sees contains only counts, never file names.

To stop: `docker compose stop` (or click "hand back to the cloud", 交还云端). Tasks in progress are returned to the server and the cloud containers take over again. If the computer shuts down or loses its connection, the server falls back to cloud containers after about 2 minutes, and tasks left over from the takeover are re-sent by the hourly cron.

## Library: browse and upload (recommended)

The UI shows the library on the left and ongoing tasks (upload progress, processing, recently finished) on the right. The library works like the web app: open folders and subfolders and see photo thumbnails. **Uploads go into the folder you're in**: click "Upload files" or "Upload a folder", or drag files and folders onto the page (a folder keeps its directory structure as subfolders). HEIC + MOV pairs become Live Photos, RAW + JPEG pairs become one item, and duplicates are skipped, just like uploading in the web app.

- While this device is processing, uploaded photos are processed right here, **without downloading the originals from the server again**. When it isn't, cloud containers process them (which costs container time); the UI tells you which.
- This page reads the files and hands them to the local program, so **keep the page open while sending**. If you close it, choose the remaining files again (ones already uploaded are skipped as duplicates) or click "Cancel the rest".
- This UI has no login of its own: once the device is signed in to your library, anyone who can open `localhost:7878` on this computer can browse your photos (the port is bound to this machine only; other devices on your network can't reach it).
- Staged files take at most 4 GB of disk; when that's full, sending waits until this computer has processed some. They're deleted once processed, cancelled, or handed back to the cloud.

## How it works

- Identity: it signs in with your own Access login (`cloudflared access login`), just like the browser. The server has no extra account, token or back door for it.
- Takeover: every task claim renews a 2-minute lease. While the lease is valid, the server's queue consumer doesn't start containers, and tasks wait in the database for this computer. When idle it polls every 10 seconds (renewing the lease), about 8,640 requests a day if left on all the time, a negligible cost.
- Processing: download the original → process locally → upload the thumbnail, preview and H.264 preview to the locations the server specifies → the server writes the database with exactly the same code as the container path. If something changes during processing (the photo is rotated, say), the server sees the result is stale and processes it again, so nothing wrong is written.
- Failures: as with containers, each task is attempted at most 3 times. After 5 failures in a row it hands back to the cloud automatically (most likely a problem with the local environment).
- Security: the UI binds to this machine only (`127.0.0.1:7878`) and checks the Host header. Originals sit in the container's temporary folder only while being processed and are deleted afterwards.

## Development

With a local `wrangler dev`, use `http://host.docker.internal:8787` as the site address (no login needed).

```bash
cd apps/device && node --test "test/*.test.mjs"   # the parts that don't need Docker (not part of the pnpm workspace)
```
