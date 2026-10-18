---
title: Deploy errors
description: Common Workers Builds failures and fixes.
sidebar:
  order: 1
---

A failed deploy **never affects the live version**: the new code only goes live after every check passes and migrations succeed.

## `Cannot generate the deploy config`

A resource (D1, KV, a Vectorize index…) couldn't be found by name when generating the deploy config; the log says which. Usually an upstream release added a resource.

Run `pnpm run setup` locally once (it skips what exists and creates what's missing), then retry the build.

## `NANA_DOMAIN`

The build variable is missing, or contains `https://`. Use the hostname only, e.g. `photos.example.com`.

## Permission errors

The token Workers Builds generated lacks a permission. Under the Worker › Settings › Build › API token, add:

- D1 Edit (look up IDs, run migrations)
- Workers KV Storage Read (look up IDs)
- Workers Routes / Domains Edit (bind the custom domain)
- Container image push (usually already there)

## pnpm fails to install

The required version is in `packageManager` in the root `package.json`. If the build image can't install it, set the pnpm version in the build's environment variables.

## Tests fail

If a check in `pnpm run ci` (cost rules, type check, tests, frontend build) fails on your fork and you haven't changed any code, it's probably an upstream problem. Check upstream for a fix, or [open an issue](https://github.com/darmau/nana-storage/issues).

## Deployed, but it won't open

- **Back to the login page / 403 every time**: check that the `OWNER_EMAIL` secret exactly matches the email you sign in with, and that `ACCESS_AUD` is this Access application's AUD. Running `pnpm run setup` again overwrites them.
- **The domain doesn't resolve**: make sure the domain is on the same Cloudflare account, and that the Worker › Settings › Domains & Routes lists it.
- **Blank page**: check the browser console for errors and include them in an issue.
