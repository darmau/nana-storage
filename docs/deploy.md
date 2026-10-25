# 部署

[English](deploy.en.md) · 简体中文

整个应用只有一个 Worker（`nana-storage`）。推送到 GitHub 的 `main` 分支后，由 Cloudflare **Workers Builds** 自动构建和部署：先跑类型检查、测试和成本规则检查，全部通过才会迁移 D1 并部署（包括构建、推送容器镜像）。

下面的一次性配置只需要做一遍。

部署者的信息（域名、邮箱、资源 ID）都**不写进仓库文件**：域名放在 Workers Builds 的构建变量 `NANA_DOMAIN` 里，D1 / KV 的 ID 在部署时按名字查（`scripts/render-wrangler.mjs` 从模板 `apps/worker/wrangler.jsonc` 生成 `wrangler.deploy.json`），身份信息是 Worker secret。所以你的 fork 和上游完全一致，以后在 GitHub 上点 **Sync fork** 就能更新，不会有冲突。

## 一、准备

1. Cloudflare 账号开通 **Workers Paid**（Containers 必须），并在 Zero Trust 里选好计划（免费即可）。
2. 域名托管在 Cloudflare，决定一个子域名，比如 `photos.example.com`（下文都用它代替）。
3. 在 GitHub 上 **fork** 本仓库，clone 到本机。本机需要 Node 24 和 pnpm。

## 二、初始化（`pnpm run setup`）

```bash
pnpm install
cd apps/worker && npx wrangler login && cd ../..
pnpm run setup
```

脚本（提示是英文的）会问域名和邮箱，然后：

- 创建 D1（`nana-db`）、R2（`nana-photos`）、KV（`nana-kv`）、队列（`nana-jobs`、`nana-jobs-dlq`）、Vectorize 索引 `nana-faces`（512 维 cosine）；已存在的跳过；
- 执行 D1 迁移；
- 用你临时提供的 API 令牌建 Zero Trust Access 应用：整个主机名、只放行你的邮箱、只用邮箱验证码（One-time PIN）登录、会话 24 小时，并打开 D1 读复制。令牌只在这次运行中使用，不保存，用完可以删掉。不想给令牌时可以手动建应用，再把团队域名和 AUD 填进去（步骤脚本会打印）；
- 写入 Worker secret：`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`OWNER_EMAIL`。

缺少任何一个身份相关的 secret 时，Worker 会拒绝所有请求。R2 桶保持默认状态：**不要**开启公开访问、r2.dev 子域名或自定义域名。

脚本可以重复运行：上游新增了资源（比如新的 Vectorize 索引）时，部署会在生成配置这一步报出缺少什么，再运行一次 `pnpm run setup` 补上即可。

D1 读复制（可选，建议）：打开之后，API 的读查询会落到离你近的副本上（`src/dbcache.ts` 的会话保证读到自己刚写的数据），写入仍然走主库。副本不额外收费，按同样的读写行数计费。不打开也能正常工作，只是所有查询都去主库。没给令牌时可以在后台打开：D1 → `nana-db` → **Settings** → **Enable Read Replication**。

## 三、连接 GitHub（Workers Builds）

1. 使用你 fork 的仓库（不需要改任何文件）。
2. Cloudflare 后台 → Workers & Pages → `nana-storage` → 设置 → 构建 → 连接 Git 仓库，按提示授权 Cloudflare 的 GitHub App（只授权这一个仓库）。
3. 构建配置：

| 设置 | 值 |
|---|---|
| 生产分支 | `main` |
| 根目录 | `apps/worker`（`wrangler.jsonc` 所在的目录） |
| 构建命令 | `cd ../.. && pnpm install --frozen-lockfile && pnpm run ci` |
| 部署命令 | `cd ../.. && pnpm run deploy` |
| 构建变量 | `NANA_DOMAIN` = `photos.example.com`；可选 `NANA_FACES` = `off`（见下面“人脸识别”） |
| 非生产分支构建 | **关闭**（其他分支只会上传代码、不更新容器镜像，而且预览 URL 已经关闭） |

   为什么这样配：这是一个 pnpm monorepo，只有一个 Worker，它的配置在 `apps/worker/wrangler.jsonc`，前端构建产物 `apps/web/dist` 通过配置里的 `assets.directory` 一起部署。Workers Builds 要求根目录指向 wrangler 配置文件所在的目录（它用里面的 `name` 核对要部署的 Worker，`wrangler.jsonc` 里的名字是 `nana-storage`，后台的 Worker 也要叫这个名字）。依赖是在仓库根目录用 pnpm workspace 安装的，所以两条命令都先 `cd ../..` 回到仓库根目录。

4. 第一次构建时注意看日志。以下几处我没法在本地验证：
   - pnpm 版本：仓库要求 pnpm 12（`package.json` 里的 `packageManager`）。如果构建环境装不上，在构建设置的环境变量里指定 pnpm 版本。
   - 令牌权限：Workers Builds 自动生成的令牌需要能列出 D1 / KV（生成配置时按名字查 ID）、执行 D1 迁移、推送容器镜像、绑定自定义域名。如果在这几步报权限错误，到构建设置里给令牌补上 D1 编辑、KV 读取、Workers 路由/域名的权限。
   - 构建环境里没有 `python3` 或 `unzip` 时，zip 格式校验测试会跳过（日志里有提示），不影响部署。

## 人脸识别（可选关闭）

人脸识别用的 InsightFace 模型权重**只允许非商业使用**（见 `NOTICE`）。不能接受这个条件时，在 Workers Builds 的构建变量里加 `NANA_FACES` = `off`：容器镜像不下载人脸模型，处理时不做人脸识别，“人物”页保持为空，其他功能不受影响。用设备端处理的话，`apps/device` 下也要用同样的值构建（`NANA_FACES=off docker compose up -d --build`）。

关掉之前已经识别的人脸会保留；之后再打开，只有新处理的照片会识别人脸。

## 四、预算告警

账单 → 计费用量 → 预算告警：设 $20、$50、$100 三档。告警只发通知，不会封顶；真正的硬上限是应用内的 `UsageGuard` 熔断（本月容器估算费用的月度上限，默认 $10，在设置页“成本防护”里查看和修改）。

## 部署后检查

- [ ] 用无痕窗口打开 `https://photos.example.com`：先跳到 Access 登录，用邮箱验证码登录后能正常使用。
- [ ] `curl -i https://photos.example.com/api/me` 不带 cookie：被 Access 拦下（跳转到登录页或返回 403），拿不到数据。
- [ ] `nana-storage.<子域>.workers.dev` 打不开（`workers_dev: false`）。
- [ ] R2 桶的公开访问是关闭状态。
- [ ] 上传几张照片，在设置页看到任务完成，时间线里出现照片。
- [ ] 设置页的“容器运行时长”有合理的增长；观察容器空闲后多久停止（本地是任务一结束就停）。
- [ ] 地图页能显示底图和照片标记。
- [ ] “探索 › 主题”和重复照片页正常；Workers 日志里没有 `face_upsert_failed` / `face_recognize_failed`。

## 更新

- 在 GitHub 上打开你的 fork，点 **Sync fork**。Workers Builds 会自动跑测试、执行新的 D1 迁移、部署新版本。
- 想自动更新：在 fork 的 Actions 页面启用工作流，`Sync upstream`（`.github/workflows/sync-upstream.yml`）每周把 `main` 快进到上游最新的发布版本（`v*` tag）；想跟随上游的 `main`，把仓库变量 `NANA_SYNC_REF` 设为 `main`。它只做快进，你的 `main` 上有自己的提交时会失败并提示手动合并；上游改了工作流文件的那一次需要手动点 Sync fork。
- 迁移都兼容上一个版本的代码，跳过几个版本直接同步也可以；需要手动操作的变更会写在 `CHANGELOG.md` 里。
- 如果构建在生成部署配置这一步失败（`Cannot generate the deploy config`），日志会写清楚缺少哪个资源，在本机运行一次 `pnpm run setup` 再重试构建。
