---
title: 参与开发
description: 本地开发、测试和两条不能违反的原则。
---

欢迎提 issue 和 PR。完整的工程规则在仓库的 [CLAUDE.md](https://github.com/darmau/nana-storage/blob/main/CLAUDE.md)，[CONTRIBUTING.md](https://github.com/darmau/nana-storage/blob/main/CONTRIBUTING.md) 是摘要。

## 两条不能违反的原则

1. **安全**：除了 `OWNER_EMAIL` 本人，任何人都不能以任何方式拿到照片。每个请求（包括静态资源）都经过 `authenticate()`；不加任何跳过鉴权的开关、调试路由或 R2 公开访问；CSP 只允许同源（地图底图除外）。
2. **成本**：不能出现预期外的账单。不用 Durable Object alarm、不用 R2 事件通知、Worker 不请求自己、只有 `jobs.ts` 能往队列里投递。新增任何会重复运行的东西（Cron、队列、循环、轮询），先写清楚它的上限和最坏情况下每天的费用。

## 本地开发

需要 Node 24、pnpm 和 Docker（`wrangler dev` 会在本地构建并运行处理容器）。

```bash
pnpm install
cd apps/worker
cp .dev.vars.example .dev.vars          # 本地模拟的身份
npx wrangler d1 migrations apply nana-db --local
cd ../web && npx vite build             # Worker 从 apps/web/dist 提供前端
cd ../worker && npx wrangler dev        # http://localhost:8787
```

前端开发时可以用 Vite 开发服务器：在 `.dev.vars` 里设 `APP_ORIGIN=http://localhost:5173`，然后在 `apps/web` 下运行 `npx vite`（`/api` 会代理到 8787）。

本地没有 Vectorize：相似照片、人物归组不可用。不要用 `wrangler dev --remote`。

## 提交之前

```bash
pnpm run ci     # 成本规则 + i18n + 类型检查 + 全部测试 + 前端构建（和 Workers Builds 一样）
```

- **界面文案**同时写进 `apps/web/src/i18n/zh-CN.ts` 和 `en.ts`，组件里不写死文案。
- **数据库迁移**会在新代码部署之前执行，部署者可能一次跳过很多版本：只能加表、加列、加索引；删除或改名旧代码还在用的列要分两个发布版本，并写进 `CHANGELOG.md`。
- **部署者的配置不进仓库**：`wrangler.jsonc` 是模板。新增资源或必需的 secret 时，同时改 `scripts/setup.mjs`、`scripts/render-wrangler.mjs` 和 `CHANGELOG.md`。
- **日志**只记 ID。

端到端测试和浏览器测试见仓库 README 的“测试”一节。

## 本网站

网站在仓库的 `site/` 目录（Astro + Starlight），不属于 pnpm 工作区：

```bash
cd site
pnpm install --ignore-workspace
pnpm dev
```

截图由 `site/scripts/` 下的脚本生成：`pick-photos.mjs` 挑选 CC0 照片，`seed-demo.mjs` 导入一个独立的本地实例，`screenshots.mjs` 截图。
