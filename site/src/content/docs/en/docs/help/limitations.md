---
title: Known limitations
description: What isn't supported or hasn't been tested yet.
sidebar:
  order: 5
---

## Not planned, by design

- **Multiple users, share links, public albums**: it's for one person, and everything is visible only to you. This is part of the security model.
- **A mobile app**: use the browser or add it to your home screen (PWA).
- **Automatic phone backup**: there's no background sync; upload by hand.

## Current limitations

- Safari on iPhone can only upload still images. For complete Live Photos, export unmodified originals from Photos on a Mac and upload those; see [Uploading](../../guide/upload/#exporting-originals-from-iphone--mac).
- Videos over 5 minutes or 2 GB aren't transcoded; only the original is kept (Safari and Macs play it directly).
- The motion part of Live Photos isn't transcoded: browsers that can't decode HEVC, such as Firefox, show the still photo only.
- Videos can't be rotated or cropped.
- RAW processing hasn't been tested with files from every camera. If a RAW fails to decode, please open an issue with the camera model.
- Search covers file names and descriptions, not content (use [Topics](../../guide/similar/#topics) to find photos by content).
- The base map depends on OpenFreeMap: if it's down, the map page won't load; nothing else is affected.
- Local development has no Vectorize: similar photos and grouping faces into people don't work there.
