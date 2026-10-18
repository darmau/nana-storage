---
title: Device security
description: The device UI has no login of its own, and what that means.
sidebar:
  order: 4
---

## The trade-off

The device UI (`localhost:7878`) has **no login of its own**. Once the device is signed in to your library, **anyone who can open port 7878 on this computer can browse your photos**. This is deliberate:

- The port is bound to `127.0.0.1` only; other devices on your network can't reach it.
- The Host header is checked, so other websites can't reach it through DNS rebinding.
- Write actions require a dedicated request header, so other web pages can't upload on your behalf.

So don't leave on-device processing running under a computer account you share with others, and `docker compose stop` it when not in use.

## What it can and can't do

- It signs in with your own Access login (`cloudflared`) — the same identity and checks as your browser. The server has no service token or second identity for it.
- Its dedicated server endpoints can only **read input files of jobs it has claimed and that are still running**, and only **write the derived files in that job's current plan** (paths carry a version, so they no longer match if the photo changed).
- Browsing and uploading use exactly the same endpoints as the browser.
- The server queue it sees contains only counts, never file names.
- Originals sit in the container's temporary folder only while being processed and are deleted afterwards; the staging folder is cleared when the container restarts.
