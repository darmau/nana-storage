---
title: Post-deploy checklist
description: Confirm only you can get in and photos get processed.
sidebar:
  order: 4
---

## Security

- [ ] Open `https://photos.example.com` in a **private window**: you're sent to the Access login first, and after the email code the app works.
- [ ] A request without cookies is stopped by Access (redirect to login or 403) and returns no data:

  ```bash
  curl -i https://photos.example.com/api/me
  ```

- [ ] `nana-storage.<your-subdomain>.workers.dev` doesn't open (`workers_dev: false`).
- [ ] R2 › `nana-photos` › Settings: public access is off, with no r2.dev subdomain or custom domain.
- [ ] Zero Trust › Access › Applications: the policy includes only your own email.

## Features

- [ ] Upload a few photos; Settings › Background processing shows the jobs finishing and they appear in the timeline.
- [ ] Container time in Settings › Cost protection grows reasonably, and containers stop after jobs end.
- [ ] The map page shows the base map and photo locations.
- [ ] A photo's info panel (shortcut `i`) shows similar photos, and the Workers logs contain no `vectorize_query_failed` / `vectorize_upsert_failed`.
- [ ] Explore › Topics and the duplicates page open.

## Recommended

- Set budget alerts on your Cloudflare bill; see [Options](../options/).
- To follow upstream automatically, see [Updating](../updating/).
- Importing lots of photos? Read [Costs](../../costs/) and [On-device processing](../../device/install/) first.
