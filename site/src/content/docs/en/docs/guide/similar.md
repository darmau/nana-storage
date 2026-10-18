---
title: Similar photos, duplicates and topics
description: Find duplicates, see similar photos, find photos by content.
sidebar:
  order: 8
---

Each photo gets two "fingerprints" during processing: a perceptual hash (does it look the same?) and a CLIP image vector (is the content similar?). Both come from the same processing pass, with no extra container call.

## Duplicates

Explore › Duplicates groups copies of the same photo (re-exported, recompressed, resized).

- Open a group to compare them stacked in one place: ← → or number keys to switch, click to zoom (the zoom position is kept as you switch), ↑ ↓ for the next group.
- Keep the one you want and delete the rest (to the trash).
- If they aren't duplicates, mark them "Not duplicates" and they won't come back.

To avoid flagging shots from the same scene: photos in the same burst never count; when both have camera EXIF, their capture times must be nearly identical; when both have vectors, their content must be very similar. Videos and photos are never compared.

## Similar photos

At the bottom of the viewer's info panel: the 30 photos closest in content (excluding the same burst). Only queried when you open the panel.

## Topics

Explore › Topics lets you browse by **subject** — dogs, cars, sunsets.

1. **Create**: select a few photos of the same kind anywhere, then action bar › Topics › New. They become "positive" samples. You can also add photos that don't belong as "negative" samples.
2. **Learn**: a topic is a small classifier trained on your photos. Click "Update" to train now and search the whole library; otherwise the hourly job updates it 10 minutes after you stop changing samples.
3. **Review**: suggestions, with the ones the classifier is least sure about first. Select and answer yes / no, or review one by one (Y yes, N no, S skip). The more you answer, the better it gets.
4. **Results**: positives plus suggestions scoring above the sensitivity (Strict / Normal / Loose), sorted by date. Select some to add to an album, or mark them as not belonging.

**The classifier only suggests**; you decide what goes into an album. Once there are at least 10 positives and 10 negatives, cross-validated quality is shown (how many positives it recognizes, how many negatives it rejects), and samples that contradict the classifier are flagged — usually a mis-click.

## In local development

`wrangler dev` has no Vectorize: similar photos and "confirm more photos" report they're unavailable, and faces are recorded but not grouped. Everything works once deployed to Cloudflare.
