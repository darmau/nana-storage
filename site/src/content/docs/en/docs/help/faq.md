---
title: FAQ
description: Cost, privacy, multiple users, formats and more.
sidebar:
  order: 6
---

### What does it really cost per month?

Once everything is processed, a few thousand photos is basically the $5 Workers Paid plan; 50,000 photos is about $8–9 (mostly R2 storage). Processing is paid once, at upload. See [Costs](../../costs/).

### Could I get a huge bill out of nowhere?

The design avoids anything that runs on its own indefinitely, and processing pauses automatically when this month's container spend reaches your cap ($10 by default). Setting budget alerts on your Cloudflare bill is recommended too. See [Costs › The monthly cap](../../costs/#the-monthly-cap-circuit-breaker).

### Can family members have accounts?

No — Nana is for one person. Each person can deploy their own copy (their own Cloudflare account, or a differently named Worker in the same account, which needs repository changes and isn't recommended).

### Can Cloudflare see my photos?

The photos live in your Cloudflare account; as with any cloud storage, the provider technically has access. Nana's promise is that no one other than you and your cloud provider can obtain them: no public links, no CDN cache, no outside services.

### Are originals compressed or modified?

No. Originals are stored as-is in R2; edits only change thumbnails and previews.

### Which formats are supported?

JPEG, HEIC, PNG, WebP, AVIF, GIF, TIFF, the common RAW formats, MP4 and MOV. See [Uploading](../../guide/upload/#supported-formats).

### Can my own computer do the processing, without container costs?

Yes — see [On-device processing](../../device/install/).

### Can face recognition be used commercially?

The InsightFace model weights are for non-commercial use only. You can turn face recognition off at deploy time; see [Options](../../deploy/options/). The code itself is AGPL-3.0.

### How do I update?

Click Sync fork on GitHub, or enable the sync workflow. See [Updating](../../deploy/updating/).

### What does the name mean?

那时 (nà shí) means "back then" — as in photos from back then.
