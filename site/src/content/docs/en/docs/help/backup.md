---
title: Backup, export and migration
description: How to get your photos and metadata out.
sidebar:
  order: 4
---

Everything is in your own Cloudflare account and you can take it out at any time. Cloudflare's storage is redundant, but that **doesn't protect against mistakes or account problems** — keep another copy of important photos elsewhere.

## Download by folder (with original file names)

Select everything in a folder or album › Download to get a zip with the original file names, including Live Photo videos and RAW attachments. Up to 1,000 items per download.

Good for: taking some photos out, sharing them, or moving to other photo software.

## Back up the whole R2 bucket (all originals)

Use [rclone](https://rclone.org) to sync the bucket to a local disk or NAS:

1. Cloudflare dashboard › R2 › Manage API tokens › Create token, with **Object Read** on the `nana-photos` bucket only. Note the Access Key ID, Secret Access Key and endpoint.
2. `rclone config`: new remote, type S3, provider Cloudflare, with the three values above.
3. Sync:

   ```bash
   rclone sync r2:nana-photos /Volumes/Backup/nana-photos --progress
   ```

R2 has no egress fees; downloading is billed only per read operation (a few per photo).

Files in R2 are named by ID (originals under `o/<photo ID>/<file ID>`, thumbnails and previews under `d/`). Keep it together with the D1 backup below to recover file names and metadata. This is the "just in case" full backup.

## Back up D1 (metadata)

D1 metadata (dates, locations, descriptions, folders, albums, people, edits) is Nana's own data. Its main protection is D1's built-in **[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)**: restore the database to any point in the last 30 days, with no setup in advance.

```bash
cd apps/worker
npx wrangler d1 time-travel info nana-db -c wrangler.deploy.json        # restore points
npx wrangler d1 time-travel restore nana-db --timestamp=<time> -c wrangler.deploy.json
```

(`wrangler.deploy.json` is generated when you run `pnpm run setup`.)

For an offline copy, export to SQL. The database contains virtual tables for full-text search, so `wrangler d1 export` can't export it whole; list the regular tables with `--table`:

```bash
cd apps/worker
npx wrangler d1 export nana-db --remote -c wrangler.deploy.json --output nana-db.sql \
  --table assets --table asset_files --table folders --table albums --table album_assets \
  --table people --table faces --table face_scans --table face_rejects \
  --table smart_sets --table smart_set_examples --table duplicate_ignores
```

Original file names are in `asset_files.original_name`, matching the `r2_key` in R2.

## Moving to another Cloudflare account

The simplest, most reliable way: [deploy](../../deploy/prepare/) fully on the new account, then download your photos folder by folder and upload them to the new library (or upload whole directories from the device UI). Dates and locations are read from the originals again, and people and similar photos are recognized again. What you lose: albums, favorites, manually edited metadata, edits and people's names.

A full migration (with albums, people and edits) means moving the R2 bucket and D1 data together and working with the database directly; there's no ready-made tool yet. If you need it, describe your case in an [issue](https://github.com/darmau/nana-storage/issues).

## Leaving Nana

Originals are never modified: the zip downloads or the R2 sync above give you exactly the files you uploaded, ready to import into any other photo software. Edits (crops, blurs) exist only in Nana's own thumbnails and previews.
