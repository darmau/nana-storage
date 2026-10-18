---
title: People
description: Automatic face recognition; naming, merging and fixing mistakes.
sidebar:
  order: 7
---

Faces are detected as new photos are processed. Once the same person appears in at least 3 photos, they show up under Explore › People. It works much like iOS Photos or Google Photos: a "person" is a group of faces of the same person, and the name can be left empty.

:::caution[License]
The InsightFace model weights used for faces are for **non-commercial use only**. If that's a problem, turn face recognition off at deploy time (`NANA_FACES=off`); see [Options](../../deploy/options/).
:::

## Naming and merging

- On a person's page, click "Add name".
- If you type a name that already exists, you're asked whether it's the same person and can merge them.
- Or use "Merge with another person" in the person's menu.
- Hide people you don't want in the list (photos are unaffected); add the ones you look at often to your favorites so they come first.
- Cover: right-click a photo on the person's page › set as cover, or click a face in the viewer's info panel.

## Fixing mistakes

- **Not "X"**: select the wrongly matched photos on X's page and choose "Not X". Those faces are recognized again and **won't go back to X** — usually they land on the right person straight away.
- **Someone else…**: assign the selected photos to another person (or a new one). Manual assignments always win; automatic recognition never undoes them.
- In the viewer's info panel, clicking a face also lets you view, reassign or reject it.

## Confirm more photos

"Confirm more photos" on a person's page finds faces that may be this person but aren't assigned yet and asks, one at a time, "Is this X?".

## Filter a folder by person

A folder page shows the people in that folder; tap a face to see only photos with them.

## Faces that aren't recognized

- Faces that are too small (under 36 pixels) or low-confidence are recorded but not grouped.
- Faces covered by [blur](../edit/).
- Faces in videos.

## Privacy

Detection and recognition run in your own processing container (or on your own computer). Face vectors and names are stored only in your D1 and Vectorize, and no outside service is called. Logs never contain names.
