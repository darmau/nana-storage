---
title: Options
description: Turning off face recognition, D1 read replication, budget alerts.
sidebar:
  order: 5
---

## Turn off face recognition

The InsightFace model weights used for face recognition are licensed for **non-commercial use only** (see `NOTICE` in the repository) and aren't covered by the AGPL. If you can't accept that, add this Workers Builds variable:

```
NANA_FACES = off
```

- The container image doesn't download the face models, no face recognition runs, and the People page stays empty. Nothing else is affected.
- With [on-device processing](../../device/install/), build it with the same value: `NANA_FACES=off docker compose up -d --build`. Otherwise photos processed on your computer get faces and photos processed in the cloud don't.
- Faces recognized before you turned it off are kept. If you turn it back on, only newly processed photos are scanned.

## D1 read replication

API reads are served from a nearby replica while writes go to the primary. The app uses D1 sessions so you always read your own writes. Replicas cost nothing extra; rows read and written are billed the same.

If you gave setup an API token it's already on; otherwise enable it in the dashboard: D1 › `nana-db` › Settings › Enable Read Replication.

## Budget alerts

Cloudflare dashboard › Billing › Billable usage › Budget alerts: set a few, e.g. $20, $50, $100.

Alerts only notify; they don't cap anything. The real hard limit is the in-app breaker (a monthly cap on estimated container spend, $10 by default); see [Costs](../../costs/). The two complement each other: the app only knows what it can compute, the billing alert sees everything.

## Containers running at once

By default up to 4 containers process photos at once. For a big import you can raise this temporarily in Settings › Cost protection (up to 32, for at most 7 days, then it falls back automatically). More containers only make it faster; total container time stays the same.
