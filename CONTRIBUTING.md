# Contributing / 贡献

Thanks for helping. The full engineering rules live in [CLAUDE.md](CLAUDE.md) (in Chinese); this page summarizes what matters most for a pull request.

欢迎贡献。完整的工程规则在 [CLAUDE.md](CLAUDE.md)，这里只列提交 PR 时最要紧的几条。

## Two non-negotiable constraints / 两条不能违反的约束

1. **Security**: nobody but `OWNER_EMAIL` may obtain a photo by any means. Every request, static assets included, goes through `authenticate()`. Never add an auth bypass, debug route or public R2 access. Keep the CSP `'self'`-only (the map tiles are the single exception).
   **安全**：除了 `OWNER_EMAIL` 本人，任何人都不能拿到照片。不加任何跳过鉴权的开关或调试路由，不开 R2 公开访问，CSP 只允许同源（地图底图除外）。
2. **Cost**: no unexpected bills. No Durable Object alarms, no R2 event notifications, no self-requests, and only `jobs.ts` may enqueue. Any new cron, queue, loop or poll must state its upper bound and worst-case daily cost. `pnpm check:cost-rules` enforces part of this.
   **成本**：不能出现预期外的账单。不用 DO alarm、不用 R2 事件通知、Worker 不请求自己；新增任何会重复运行的东西，先写清楚上限和最坏情况下每天的费用。

Security issues go through [SECURITY.md](SECURITY.md), not public issues.

## Before opening a PR / 提交之前

```bash
pnpm install
pnpm run ci          # cost rules, i18n, type check, all tests, frontend build
```

- **i18n**: UI text goes into both `apps/web/src/i18n/zh-CN.ts` and `en.ts`. No literal Chinese in `apps/web/src` outside `i18n/` (`pnpm check:i18n --strict`).
  界面文案同时写进两个语言文件。
- **Migrations** run before the new code is deployed, and deployers may skip versions. Only add tables, columns or indexes; dropping or renaming a column needs two releases, noted in `CHANGELOG.md`.
  迁移只能加表、加列、加索引；删列至少隔一个发布版本。
- **Deployer config stays out of the repository.** `apps/worker/wrangler.jsonc` is a template: never put a domain, resource ID or email in it. New resources or required secrets also need `scripts/setup.mjs`, `scripts/render-wrangler.mjs` and a `CHANGELOG.md` entry marked as needing action.
  不要往仓库里加部署者需要改的配置；新增资源或 secret 时同步改 setup、render 脚本和 CHANGELOG。
- **Logs** contain IDs only, never file names, GPS data, descriptions or person names.
  日志只记 ID。

## License / 许可

By contributing, you agree that your contribution is licensed under the [AGPL-3.0](LICENSE), like the rest of the project.

提交贡献即表示你同意它和本项目一样按 AGPL-3.0 授权。
