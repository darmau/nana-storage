---
title: Contributing
description: Local development, tests and the two rules that can't be broken.
---

Issues and pull requests are welcome. The full engineering rules are in [CLAUDE.md](https://github.com/darmau/nana-storage/blob/main/CLAUDE.md) (in Chinese); [CONTRIBUTING.md](https://github.com/darmau/nana-storage/blob/main/CONTRIBUTING.md) summarizes them.

## Two rules that can't be broken

1. **Security**: nobody but `OWNER_EMAIL` may obtain a photo by any means. Every request, static assets included, goes through `authenticate()`. Never add an auth bypass, debug route or public R2 access. Keep the CSP same-origin only (the map tiles are the one exception).
2. **Cost**: no unexpected bills. No Durable Object alarms, no R2 event notifications, no self-requests, and only `jobs.ts` may enqueue. Any new cron, queue, loop or poll must state its upper bound and worst-case daily cost.

## Local development

You need Node 24, pnpm and Docker (`wrangler dev` builds and runs the processing container locally).

```bash
pnpm install
cd apps/worker
cp .dev.vars.example .dev.vars          # simulated local identity
npx wrangler d1 migrations apply nana-db --local
cd ../web && npx vite build             # the Worker serves apps/web/dist
cd ../worker && npx wrangler dev        # http://localhost:8787
```

For frontend work, use the Vite dev server: set `APP_ORIGIN=http://localhost:5173` in `.dev.vars` and run `npx vite` in `apps/web` (`/api` is proxied to 8787).

There's no Vectorize locally: similar photos and people grouping don't work. Don't use `wrangler dev --remote`.

## Before opening a PR

```bash
pnpm run ci     # cost rules + i18n + type check + all tests + frontend build (same as Workers Builds)
```

- **UI text** goes into both `apps/web/src/i18n/zh-CN.ts` and `en.ts`; no hard-coded strings in components.
- **Migrations** run before the new code is deployed, and deployers may skip versions: only add tables, columns or indexes. Dropping or renaming a column the old code uses takes two releases and a `CHANGELOG.md` entry.
- **Deployer config stays out of the repository**: `wrangler.jsonc` is a template. New resources or required secrets also need `scripts/setup.mjs`, `scripts/render-wrangler.mjs` and a `CHANGELOG.md` entry.
- **Logs** contain IDs only.

End-to-end and browser tests are described in the README's testing section.

## This website

The website lives in `site/` (Astro + Starlight), outside the pnpm workspace:

```bash
cd site
pnpm install --ignore-workspace
pnpm dev
```

Screenshots come from the scripts in `site/scripts/`: `pick-photos.mjs` picks CC0 photos, `seed-demo.mjs` imports them into a separate local instance, and `screenshots.mjs` captures the pages.
