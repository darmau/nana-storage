---
title: Connect Workers Builds
description: Let Cloudflare test, migrate and deploy from your fork automatically.
sidebar:
  order: 3
---

On every push to `main`, Cloudflare **Workers Builds** type-checks, tests and checks the cost rules → if everything passes, applies D1 migrations → deploys the Worker and the container image.

## Connect the repository

Cloudflare dashboard › Workers & Pages › `nana-storage` › Settings › Build › **Connect a Git repository**. Authorize Cloudflare's GitHub App (preferably for this repository only) and choose your fork.

## Build configuration

| Setting | Value |
|---|---|
| Production branch | `main` |
| Root directory | `apps/worker` |
| Build command | `cd ../.. && pnpm install --frozen-lockfile && pnpm run ci` |
| Deploy command | `cd ../.. && pnpm run deploy` |
| Build variables | `NANA_DOMAIN` = `photos.example.com` |
| Non-production branch builds | **Off** |

Optional build variable: `NANA_FACES` = `off` turns off face recognition; see [Options](../options/).

### Why

- The repository is a pnpm monorepo whose only Worker config is `apps/worker/wrangler.jsonc`. Workers Builds needs the root directory to hold that file and checks its `name` (`nana-storage`) against the Worker in the dashboard, so the Worker must have that name.
- Dependencies are installed from the repository root, so both commands `cd ../..` first.
- The frontend build output `apps/web/dist` ships with the Worker through `assets.directory`; no Pages project is involved.
- Non-production builds only upload a code version without updating the container image, and preview URLs (`preview_urls`) are off anyway. If the UI insists on a non-production deploy command, keep the default `npx wrangler versions upload` and switch the builds off.

## The first build

Click Retry build or push a commit. The first build also builds the container image (downloading models), so it's slower. Watch the log:

- **pnpm version**: the required version is in `packageManager` in the root `package.json`. If the build image can't install it, set the pnpm version in the build's environment variables.
- **Token permissions**: the token Workers Builds generates must be able to list D1 / KV (to look up IDs by name), run D1 migrations, push container images and bind the custom domain. If a step fails with a permission error, add D1 Edit, KV Read and Workers Routes / Domains permissions to the build token.
- Without `python3` or `unzip` in the build image, the zip-format tests are skipped (noted in the log); deployment is unaffected.
- If it fails at "generate deploy config" (`Cannot generate the deploy config`), the log names the missing resource. Run `pnpm run setup` locally again.

More in [Deploy errors](../../help/deploy-errors/).

Once it succeeds, go through the [post-deploy checklist](../checklist/).
