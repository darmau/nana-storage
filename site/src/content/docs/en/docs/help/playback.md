---
title: Playback
description: When a video or Live Photo won't play.
sidebar:
  order: 3
---

iPhone videos and Live Photos are usually **HEVC (H.265)**, which not every browser can decode.

| Content | Browsers that decode HEVC (Safari, Chrome and Edge on Mac / Windows, …) | Browsers that don't (e.g. Firefox) |
|---|---|---|
| Regular video (up to 5 min / 2 GB) | Plays the original | Plays the transcoded H.264 preview |
| Regular video (longer / larger) | Plays the original | Won't play; download the original |
| Live Photo motion | Plays | Shows the still photo only |

The motion part of Live Photos isn't transcoded: doing it for every photo would double the processing cost for a few seconds of video each.

## Also

- **HEIC photos** display in every browser (you see the processed WebP preview). Only layering the original when zoomed differs: outside Safari, a high-resolution preview is generated in the background instead. See [Browsing › Full resolution](../../guide/browse/#full-resolution-hd).
- If a video errors, the next source is tried automatically (original → H.264 preview).
