---
title: Uploading
description: Supported formats, Live Photo and RAW pairing, folders, duplicates, resuming.
sidebar:
  order: 1
---

## How to upload

- **The Upload menu** in the top bar: "Upload files…" or "Upload folder…". Browsers can't pick files and folders in the same dialog, hence two items.
- **Drag and drop** files or folders onto any page.
- **A folder card's context menu** uploads straight into that folder.

Where uploads go: on a folder page, into that folder; anywhere else, into the top level. Folders you pick or drop **keep their directory structure** as subfolders.

## Supported formats

| Kind | Formats |
|---|---|
| Photos | JPEG, HEIC / HEIF, PNG, WebP, AVIF, GIF, TIFF |
| RAW | DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2, PEF, SRW and more |
| Video | MP4, MOV (H.264 / HEVC) |

The type is detected from the **file header**, so a wrong extension doesn't matter. Unknown formats (and SVG, HTML and other files that can carry scripts) are rejected. Files can be up to 50 GB.

## Automatic pairing

- **Live Photos**: a HEIC / JPEG and MOV with the same name (`IMG_0001.HEIC` and `IMG_0001.MOV`) become one Live Photo.
- **RAW + JPEG**: a RAW and JPEG with the same name become one item. The JPEG is displayed; the RAW is kept as an attachment and downloaded along with the original.

## Duplicates

The browser computes each file's SHA-256 locally. Files **identical to one already in the library** are skipped and never uploaded twice.

Similar but not identical files (another export of the same photo) are uploaded; handle them later under [Duplicates](../similar/).

## While uploading

- Files go up in 20 MB parts; a failed part is retried automatically. At most 2 local files are read at once.
- If a local file yields no data for 60 seconds (a NAS or network drive dropped), the whole queue pauses until you click Continue.
- The upload panel estimates the batch's container cost and suggests [on-device processing](../../device/install/) for big batches.
- No need to reload: processed photos appear in the lists on their own. Progress is under Settings › Background processing.

## Interrupted uploads

If you close the page or lose the connection mid-upload, items still unfinished after an hour count as interrupted, and their folder page lists the file names. **Just upload those files again**: they don't count as duplicates, and the half-finished item is replaced.

## Exporting originals from iPhone / Mac

- **Safari on iPhone** can only upload still images (iOS hands web pages a JPEG copy without the Live Photo video).
- To keep Live Photos, HEIC originals and full metadata: in **Photos on a Mac**, select the photos › File › Export › **Export Unmodified Original**, then drag the exported folder into Nana.
- Moving from Google Photos: export with Google Takeout and upload the photo files. The JSON sidecar files from Takeout aren't read.
