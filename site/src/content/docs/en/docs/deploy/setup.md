---
title: Run setup
description: What pnpm run setup does and how to answer its questions.
sidebar:
  order: 2
---

```bash
pnpm install
cd apps/worker && npx wrangler login && cd ../..
pnpm run setup
```

`wrangler login` opens a browser to authorize your Cloudflare account. The script is safe to re-run; anything that already exists is skipped.

## What it asks

| Prompt | Answer |
|---|---|
| `Which account should it be deployed to?` | Only if you have several; pick the one with Workers Paid |
| `Domain for the library` | The library's hostname, e.g. `photos.example.com`, without `https://` |
| `The only email allowed to access the library` | Your own email. **Only this address can sign in** |
| `API token` | Used to create the Access application automatically (below). Press Enter to configure it by hand |

## What it does

1. **Creates resources** (fixed names, existing ones skipped):
   - D1 `nana-db`, R2 `nana-photos`, KV `nana-kv`
   - queues `nana-jobs` and `nana-jobs-dlq`
   - Vectorize indexes `nana-embed` and `nana-faces` (512 dimensions, cosine)
2. **Applies D1 migrations.**
3. **Creates the Zero Trust Access application**: covers the whole hostname, allows only your email, one-time PIN login only, 24-hour sessions; also turns on D1 read replication.
4. **Writes Worker secrets**: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAIL`. This also creates an empty `nana-storage` Worker, which is what you connect to GitHub next.
5. Prints the Workers Builds settings.

## The API token

Creating the Access application automatically needs a temporary API token. **It's used for this run only and never stored**; delete it afterwards.

At [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) › Create token › Custom token, grant:

- Account › Access: Apps and Policies › Edit
- Account › Access: Organizations, Identity Providers, and Groups › Edit
- Account › D1 › Edit (optional, for read replication)

It isn't echoed when you paste it.

### Without a token: configure by hand

Press Enter and the script prints the steps:

1. Zero Trust › Access › Applications › Add an application › **Self-hosted**, domain `photos.example.com`, path empty.
2. Policy: action "Allow", Include › Emails › **only your own email**.
3. Login methods: **One-time PIN only**.
4. Save, copy the application's **AUD tag**, and enter the team domain (`https://<team>.cloudflareaccess.com`) and AUD in the terminal.

D1 read replication can be turned on later in the dashboard: D1 › `nana-db` › Settings › Enable Read Replication. Without it everything works; queries just go to the primary.

## Leave R2 at its defaults

**Don't** enable public access, the r2.dev subdomain or a custom domain on `nana-photos`. Every photo byte should leave through the Worker after the identity check.

## If identity settings are missing

If any of the three secrets is missing, the Worker refuses every request — it would rather not open than let anyone in with an incomplete configuration.

Next: [Connect Workers Builds](../workers-builds/).
