---
title: Prepare
description: The accounts, domain and tools you need before deploying.
sidebar:
  order: 1
---

Deploying takes three steps: **fork the repository → run setup → connect Workers Builds**. Allow 15–30 minutes; you only do it once.

:::note
This page matches [`docs/deploy.en.md`](https://github.com/darmau/nana-storage/blob/main/docs/deploy.en.md) in the repository, which is the reference.
:::

## 1. Cloudflare account

- Subscribe to **Workers Paid** ($5 / month) under Workers › Plans. Containers are only available on the paid plan.
- Pick a **Zero Trust** plan; the free one is enough (you're the only user). The first time you open Zero Trust you choose a team name such as `myteam`, and your login domain becomes `https://myteam.cloudflareaccess.com`.

## 2. Domain

The domain must be on the same Cloudflare account (DNS served by Cloudflare). Choose a subdomain for the library, e.g. `photos.example.com` — used throughout these docs.

You don't need to create DNS records; the deploy binds the domain for you.

## 3. Code

1. Open [darmau/nana-storage](https://github.com/darmau/nana-storage) on GitHub and click **Fork**.
2. Clone your fork:

   ```bash
   git clone https://github.com/<your-username>/nana-storage.git
   cd nana-storage
   ```

3. Install **Node 24** and **pnpm** (the repository pins the pnpm version; after `corepack enable` it's used automatically).

**You don't edit any file in the repository.** Your domain, email and resource IDs never go into it: the domain is a Workers Builds variable, resource IDs are looked up by name at deploy time, and identity settings are Worker secrets. Your fork stays identical to upstream, so Sync fork updates it without conflicts.

Next: [Run setup](../setup/).
