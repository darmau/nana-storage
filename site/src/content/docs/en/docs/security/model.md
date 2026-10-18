---
title: Security model
description: What it protects against, and what it doesn't.
sidebar:
  order: 1
---

Nana's first principle: **nobody but you can obtain your photos, by any means.**

## Two gates

1. **Cloudflare Access**: the whole hostname is behind Access, letting in only your email with an email one-time PIN. Requests that aren't signed in never reach the Worker.
2. **The Worker checks again**: every request (including HTML, JS and CSS) must carry a valid Access JWT — signature, audience (AUD), and an email equal to `OWNER_EMAIL`. If any identity setting is missing, every request is refused. There is no switch, environment variable or debug route that skips authentication.

## Photo bytes

- R2 has no public access and no presigned links; every byte leaves through the Worker after the identity check.
- The `workers.dev` subdomain and preview URLs are off; the app is only reachable at your domain.
- Photo responses use `Cache-Control: private` only: they may be kept in your own browser, never in Cloudflare's CDN or any shared cache.
- There's no service worker, so photos aren't cached on devices.

## In the browser

- The CSP allows same-origin resources only; the single exception is the base map (`tiles.openfreemap.org`), allowed for images and data, never scripts.
- Write requests need a dedicated header and must be same-origin, preventing cross-site request forgery.
- Uploads are checked by file header; SVG, HTML and other files that can carry scripts are rejected.

## Not covered

- **Someone gets hold of your device**: a signed-in browser can view photos (Access sessions last 24 hours). Lock your computer and phone.
- **Your email is compromised**: with email-code login, controlling the inbox means signing in. Turn on two-factor authentication for your email — or switch Access to another login method (GitHub, Google…) in Zero Trust.
- **Your Cloudflare account is compromised**: the account owner can see everything in R2. Turn on two-factor authentication for Cloudflare.
- **The device UI**: see [Device security](../../device/security/).
- **The map**: OpenFreeMap sees which area you browse and your IP, never photos. See [Map](../../guide/map/).

## Photo metadata

Originals are stored untouched (including GPS in EXIF). Thumbnails and previews have all metadata except the color profile removed. A downloaded original is the complete file — mind the location data before sharing it.
