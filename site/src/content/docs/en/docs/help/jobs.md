---
title: Stuck or failed processing
description: Photos stuck in processing, failed jobs, requeueing.
sidebar:
  order: 2
---

Processing status is under Settings › Background processing.

## Stuck in the queue

- 4 containers run at once by default, so a queue after uploading thousands of photos is normal. Use "speed over the last 10 minutes" to estimate how long it'll take, and raise the container count temporarily in Settings › Cost protection if you like.
- If there's a breaker notice at the top, processing is paused; see [Settings › After the breaker trips](../../guide/settings/#after-the-breaker-trips).
- Speed stays at 0: click **Requeue** to re-send a batch (queue messages can get lost; the job records in D1 are accurate). Clicking again moves on to the next batch.

## Stuck "processing"

A job running for more than 20 minutes counts as stuck (e.g. its consumer was stopped by a deploy). The queue reclaims it automatically once it expires, or click Requeue (stuck jobs go first).

## Failed

"Failed" lists recent failures with their reasons. Each job is tried up to 3 times automatically.

- **Integrity check failed**: the uploaded file doesn't match the checksum the browser computed (a disk read error, a broken connection). Delete it and upload again.
- **Unsupported format / decode error**: a damaged file or an unusual RAW format. Feel free to open an issue with the camera model.
- **Timeout**: a huge panorama or video. Videos over 5 minutes or 2 GB aren't transcoded (only the original is kept) and never fail because of it.

Once the cause is fixed, click Retry (one or all).

## A video wasn't transcoded

Videos over 5 minutes or 2 GB and the motion part of Live Photos aren't transcoded; see [Playback](../playback/). A failed transcode doesn't fail the job either.
