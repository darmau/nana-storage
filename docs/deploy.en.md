# Deployment

English · [简体中文](deploy.md)

The whole app is a single Worker (`nana-storage`). When you push to `main` on GitHub, Cloudflare **Workers Builds** builds and deploys it. Type checks, tests and the cost-rule checks run first, and only if they all pass does it migrate D1 and deploy (including building and pushing the container image).

The one-time setup below only needs to be done once.

None of your details (domain, email, resource IDs) are **written into repository files**:

- The domain goes in the Workers Builds build variable `NANA_DOMAIN`.
- The D1 / KV IDs are looked up by name at deploy time. `scripts/render-wrangler.mjs` generates `wrangler.deploy.json` from the template `apps/worker/wrangler.jsonc`.
- Identity settings are Worker secrets.

Your fork therefore stays identical to upstream, and **Sync fork** on GitHub updates it without conflicts.

## 1. Prerequisites

1. A Cloudflare account on **Workers Paid** (required for Containers), with a Zero Trust plan selected (the free plan is fine).
2. A domain on Cloudflare and a subdomain for the library, e.g. `photos.example.com` (used throughout below).
3. **Fork** this repository on GitHub and clone it. You need Node 24 and pnpm locally.

## 2. Setup (`pnpm run setup`)

```bash
pnpm install
cd apps/worker && npx wrangler login && cd ../..
pnpm run setup
```

It asks for the domain and the owner email, then:

- Creates the resources, skipping any that already exist:
  - D1 `nana-db`, R2 `nana-photos`, KV `nana-kv`;
  - queues `nana-jobs` and `nana-jobs-dlq`;
  - a Vectorize index, `nana-faces` (512 dimensions, cosine).
- Applies the D1 migrations.
- Creates the Zero Trust Access application, using an API token you paste in for this run only. The token is not stored, and you can delete it afterwards. The application:
  - covers the whole hostname and allows only your email;
  - signs in with one-time PIN only, with 24-hour sessions;
  - the script also turns on D1 read replication.

  If you'd rather not provide a token, create the application by hand (the script prints the steps) and enter the team domain and AUD tag.
- Writes the Worker secrets `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `OWNER_EMAIL`.

If any identity secret is missing, the Worker refuses every request. Leave the R2 bucket at its defaults: **do not** enable public access, the r2.dev subdomain or a custom domain.

You can re-run the script at any time. When an upstream release adds a resource (a new Vectorize index, say), the deploy fails at the config-generation step and names what is missing. Run `pnpm run setup` again to add it.

D1 read replication (optional, recommended): API reads are served from a nearby replica, and writes still go to the primary. The session in `src/dbcache.ts` guarantees you read your own writes. Replicas cost nothing extra; you're billed for the same rows read and written. Without it everything still works, just against the primary. If you skipped the token, enable it in the dashboard: D1 → `nana-db` → **Settings** → **Enable Read Replication**.

## 3. Connect GitHub (Workers Builds)

1. Use your fork as-is; no files need changing.
2. Cloudflare dashboard → Workers & Pages → `nana-storage` → Settings → Builds → Connect a Git repository. Authorize Cloudflare's GitHub App for this repository only.
3. Build configuration:

| Setting | Value |
|---|---|
| Production branch | `main` |
| Root directory | `apps/worker` (where `wrangler.jsonc` lives) |
| Build command | `cd ../.. && pnpm install --frozen-lockfile && pnpm run ci` |
| Deploy command | `cd ../.. && pnpm run deploy` |
| Build variables | `NANA_DOMAIN` = `photos.example.com`; optionally `NANA_FACES` = `off` (see "Face recognition" below) |
| Non-production branch builds | **Off** (other branches only upload code without updating the container image, and preview URLs are disabled anyway) |

   Why this setup: this is a pnpm monorepo with a single Worker configured in `apps/worker/wrangler.jsonc`. The frontend build output `apps/web/dist` is deployed with it through `assets.directory`. Workers Builds needs the root directory to be the one holding the wrangler config, and it checks the `name` there (`nana-storage`) against the Worker in the dashboard, so the Worker must have that name. Dependencies are installed from the repository root as a pnpm workspace, so both commands `cd ../..` first.

4. Watch the logs of the first build. These points can't be verified locally:
   - pnpm version: the repo requires pnpm 12 (`packageManager` in `package.json`). If the build image can't install it, set the pnpm version in the build environment variables.
   - Token permissions: the token that Workers Builds generates must be able to:
     - list D1 databases and KV namespaces (to look up IDs by name);
     - run D1 migrations;
     - push container images;
     - bind the custom domain.

     If one of these fails with a permission error, add D1 Edit, KV Read and Workers Routes / Domains permissions to the build token.
   - If the build image lacks `python3` or `unzip`, the zip-format tests are skipped (with a note in the log); deployment is unaffected.

## Face recognition (can be turned off)

The InsightFace model weights used for face recognition are licensed for **non-commercial use only** (see `NOTICE`). If you can't accept that, add the build variable `NANA_FACES` = `off`:

- the container image doesn't download the face models and no face recognition runs;
- the People page stays empty, and nothing else is affected.

If you use device processing, build `apps/device` with the same value (`NANA_FACES=off docker compose up -d --build`).

Faces recognized before you turned it off are kept. If you turn it back on, only newly processed photos are scanned.

## 4. Budget alerts

Billing → Billable usage → Budget alerts: set alerts at $20, $50 and $100. Alerts only notify you and don't cap anything. The real hard limit is the in-app `UsageGuard` circuit breaker: a monthly cap on estimated container cost, $10 by default, viewable and adjustable under Settings → Cost protection.

## Post-deploy checklist

- [ ] Open `https://photos.example.com` in a private window: you are sent to Access first, and after signing in with the email code the app works.
- [ ] `curl -i https://photos.example.com/api/me` without cookies is stopped by Access (redirect to login or 403) and returns no data.
- [ ] `nana-storage.<subdomain>.workers.dev` doesn't open (`workers_dev: false`).
- [ ] Public access on the R2 bucket is off.
- [ ] Upload a few photos: Settings shows the jobs completing, and the photos appear in the timeline.
- [ ] "Container runtime" in Settings grows reasonably; note how long containers take to stop once idle (locally they stop as soon as a job ends).
- [ ] The map page shows the base map and photo markers.
- [ ] "Explore › Themes" and the duplicates page work.
- [ ] The Workers logs contain no `vectorize_query_failed` / `vectorize_upsert_failed`.

## Updating

- Open your fork on GitHub and click **Sync fork**. Workers Builds runs the tests, applies new D1 migrations and deploys the new version.
- Automatic updates: enable workflows on your fork's Actions tab. `Sync upstream` (`.github/workflows/sync-upstream.yml`) fast-forwards `main` to the latest upstream release (`v*` tag) every week.
  - To follow upstream `main` instead, set the repository variable `NANA_SYNC_REF` to `main`.
  - It only fast-forwards, so it fails with a message if your `main` has commits of its own.
  - When an upstream release changes workflow files, click Sync fork by hand that one time.
- Every migration is compatible with the previous version's code, so skipping several versions is fine. Changes that need manual action are listed in `CHANGELOG.md`.
- If a build fails at "generate deploy config", the log names the missing resource. Run `pnpm run setup` locally, then retry the build.
