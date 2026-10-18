---
title: Updating
description: Following new upstream releases.
sidebar:
  order: 6
---

## By hand

Open your fork on GitHub and click **Sync fork**. Workers Builds runs the tests, applies new D1 migrations and deploys the new version.

## Automatically

The repository ships a workflow, `Sync upstream` (`.github/workflows/sync-upstream.yml`), that fast-forwards your `main` to the latest upstream release (`v*` tag) every week:

1. Enable workflows on your fork's **Actions** tab (forks don't run Actions by default).
2. To follow upstream `main` instead of releases: Settings › Secrets and variables › Actions › Variables, add `NANA_SYNC_REF` = `main`.

It only fast-forwards:

- If your `main` has commits of its own, it fails with a message and you merge by hand.
- When an upstream release changes files under `.github/workflows`, GitHub won't let the workflow push them; that run fails, so click Sync fork by hand that one time.

## Skipping versions

Fine. Every database migration is compatible with the previous version's code (migrations run before the new code is deployed), and old columns are dropped at least one release later. Syncing from a very old version straight to the latest works.

## Updates that need action

Occasionally a release adds a resource (a new Vectorize index, say) or a secret. These are listed in [CHANGELOG.md](https://github.com/darmau/nana-storage/blob/main/CHANGELOG.md), marked as **needing action**.

If you miss one, the deploy fails at the "generate deploy config" step and names what's missing (the live version keeps running). Run `pnpm run setup` locally and retry the build.

With [on-device processing](../../device/install/), rebuild it after each update: `docker compose up -d --build` in `apps/device`.
