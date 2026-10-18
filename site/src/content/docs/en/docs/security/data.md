---
title: Where your data lives
description: What R2, D1, KV and Vectorize each hold.
sidebar:
  order: 2
---

Everything is in your own Cloudflare account:

| Storage | Holds |
|---|---|
| R2 `nana-photos` | Originals (including RAW and Live Photo videos), thumbnails, previews, H.264 previews, face sprites, base images for editing |
| D1 `nana-db` | Photo metadata (date, location, camera details, description), folders, albums, processing jobs, face boxes and vectors, people and names, fingerprints, topics, statistics |
| Vectorize `nana-embed` | One CLIP vector per photo, keyed by photo ID only — no metadata |
| Vectorize `nana-faces` | One vector per face, keyed by face ID only |
| KV `nana-kv` | Temporary download manifests, a little configuration |
| Durable Object `UsageGuard` | Daily usage accounting, the monthly cap, breaker state |

D1 is the single source of truth. Vectorize is only an index: query results are always filtered through D1, and it can be rebuilt from D1 if lost.

## Logs

Workers logs contain IDs only — never file names, GPS data, descriptions or names of people.

## Outside services

Apart from Cloudflare, only your browser contacts OpenFreeMap for map tiles. The processing container runs **without internet access**; models are downloaded at image build time, pinned by version and checksum. No AI, geocoding or analytics service is called, and there's no telemetry.

## Deleting

- Deleted photos go to the trash and are permanently deleted after 30 days.
- Permanent deletion removes every file in R2 first, then the D1 records, and makes a best effort to remove vectors.
