---
title: Report a vulnerability
description: How to get in touch about a security issue.
sidebar:
  order: 3
---

**Please don't open a public issue.** Use GitHub's private vulnerability reporting: repository › Security › [Report a vulnerability](https://github.com/darmau/nana-storage/security/advisories/new), with steps to reproduce and the impact.

All of these count as security vulnerabilities:

- reading photos, thumbnails, metadata or static assets without passing Cloudflare Access or the Worker's identity check;
- cross-site requests that trigger writes;
- device endpoints that read files not belonging to the current job;
- anything that can make the bill run away (infinite loops, retry storms, containers that never sleep).

Only the latest release gets security fixes. Keep up to date with Sync fork or the sync workflow; see [Updating](../../deploy/updating/).
