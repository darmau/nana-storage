---
title: Upload from the device UI
description: Browse and upload at localhost:7878 and process right on this computer.
sidebar:
  order: 3
---

The device UI shows the library on the left and ongoing tasks on the right (upload progress, processing, recently finished).

## Browsing

Open folders and subfolders and see thumbnails, just like the web app. It only requests data when you open or switch folders, load more, or finish an upload — no polling.

## Uploading

**Uploads go into the folder you're in**: click "Upload files" or "Upload a folder", or drag files and folders onto the page (folders keep their structure). Pairing (Live Photos, RAW + JPEG) and duplicate detection work exactly like the web app.

This is the recommended way to do big imports:

- While this computer is processing, uploaded photos are **processed right here** without downloading the originals from the server again, and no folder has to be mounted.
- When it isn't (handed back to the cloud, say), cloud containers process them and container cost applies; the UI tells you which.

## Notes

- The page reads the files and hands them to the local program, so **keep it open while sending**. If you close it, pick the remaining files again (ones already uploaded are skipped as duplicates) or cancel the rest.
- Staged files take at most 4 GB of disk; when that's full, sending waits until some are processed. They're deleted once processed, cancelled or handed back to the cloud; anything still waiting after 2 hours expires (the job then downloads as usual).
- If the breaker trips (503), it stops and waits for you to sort it out in the library and click Continue.
