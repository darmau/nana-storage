# 那时

[English](README.en.md) · 简体中文 · [官网](https://darmau.github.io/nana-storage/) · [使用文档](https://darmau.github.io/nana-storage/docs/introduction/)

部署在自己 Cloudflare 账号上的私人相册，类似 Google Photos，只给一个人用。

照片的原件和缩略图都存在你自己的 R2 里；所有页面和文件都要先通过 Cloudflare Zero Trust 登录。唯一用到的第三方服务是地图底图（OpenFreeMap），它拿不到任何照片。

## 功能

- **时间线**：按拍摄日期分组，右侧滚动条可以直接跳到任意年月；连拍折叠成一张。几万张照片也只渲染屏幕附近的部分（5 万张时最多约 1100 个 DOM 节点）。
- **上传**：支持 JPEG、HEIC、PNG、RAW 和视频。同名的 HEIC + MOV 自动合并成 Live Photo，同名的 RAW + JPEG 合并成一张；按内容去重，重复的文件自动跳过。
- **查看**：Live Photo 可以播放；视频在能解码 HEVC 的浏览器里直接播原件，其他浏览器播 H.264 预览。可以查看 EXIF 信息、下载原件。
- **整理**：文件夹树、相册、收藏，回收站保留 30 天；支持多选后批量操作，也可以打包下载成 zip。
- **编辑**：修改拍摄时间（带时区）、位置、描述；旋转、裁切、打码（毛玻璃，盖住的脸不参与人物识别）。只改缩略图和预览，原件不会被修改。
- **搜索**：按文件名和描述搜索，可以按日期、类型、相机、是否收藏筛选。
- **地图**：照片按位置聚合显示。底图来自 OpenFreeMap（全球，免费，自动更新），地名跟随界面语言。
- **人物**：自动识别人脸并按人归组，可以命名、合并、纠错（可以关闭，见“许可证”）。
- **相似与重复**：找出重复照片；查看相似照片；“主题”按被摄内容（狗、汽车……）给出建议，由你挑选放进相册。
- **设备端处理**（可选）：在自己的电脑上用 Docker 代替云端容器处理照片，可以直接读本机的原图目录，省掉容器费用。
- **其他**：简体中文 / English 界面、深色模式、可以添加到主屏幕（PWA）。

## 架构

```
浏览器 ──> Cloudflare Access（邮箱验证码，只放行一个邮箱）
             │
             ▼
        Worker：nana-storage
          ├─ Hono API + React 前端（静态资源）
          ├─ D1      元数据
          ├─ R2      原件、派生文件
          ├─ KV      下载清单、上限配置
          ├─ Queue   后台处理任务
          ├─ Vectorize  相似照片和人脸的向量索引
          ├─ Durable Object: Processor  ──> Container（libvips / exiftool / LibRaw / ffmpeg，无外网）
          ├─ Durable Object: UsageGuard     用量记账与熔断
          └─ Cron    每小时补写索引等、每天清理回收站
```

只有一个 Worker。照片上传后先进队列，再由容器读元数据、生成缩略图和预览，普通视频转码成 H.264（Live Photo 的动态部分不转码），完成后写回 R2 和 D1。

## 两条设计原则

**安全：除了本人，任何人都拿不到照片。**

- 整个站点都在 Access 后面；Worker 收到每个请求（包括静态资源）后还会再校验一次身份。缺少身份配置时，一律拒绝。
- R2 不开公开访问，也不发预签名链接；`workers.dev` 和预览地址都已关闭。
- 浏览器缓存只用 `private`；CSP 只允许同源资源；上传时按文件头校验类型，拒绝 SVG/HTML 这类可执行内容。

**成本：不可能出现失控的账单。**

- 结构上避免循环：不使用 Durable Object alarm、不使用 R2 事件通知，队列消费者不会自己重新投递。
- 容器数量固定（默认同时 4 个，池子最多 32 个）、空闲后自动停止、每个任务都有硬超时；每个任务最多尝试 3 次。
- `UsageGuard` 记录每天的用量（只显示，不限制）；本月容器的估算费用达到月度上限（默认 $10，设置页可改）或者发现循环处理时熔断，暂停后台处理和上传；上传时估算这一批的容器费用，大批量建议用设备端处理。
- `pnpm check:cost-rules` 对这些规则做静态检查，CI 里也会运行。

完整规则见 [CLAUDE.md](CLAUDE.md)。

## 目录结构

```
apps/
  worker/      Worker：API、队列消费者、Cron、Durable Objects、D1 迁移（wrangler.jsonc 在这里）
  web/         React 前端（Vite、TanStack Router/Query/Virtual、MapLibre）
  processor/   容器镜像：图片/视频处理服务
  device/      设备端处理（可选，在自己的电脑上用 Docker 运行）
packages/
  shared/      共享类型和所有成本上限常量
scripts/       成本规则检查、端到端测试、浏览器测试
docs/          部署文档
.github/       fork 自动同步上游的工作流
```

## 本地开发

需要 Node 24、pnpm 12 和 Docker（`wrangler dev` 会在本地构建并运行处理容器）。

```bash
pnpm install
cd apps/worker
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply nana-db --local
cd ../web && npx vite build        # Worker 会从 apps/web/dist 提供前端
cd ../worker && npx wrangler dev   # http://localhost:8787，本地用模拟身份登录
```

前端开发时可以改用 Vite 开发服务器：在 `.dev.vars` 里设置 `APP_ORIGIN=http://localhost:5173`，然后在 `apps/web` 下运行 `npx vite`（`/api` 会代理到 8787）。

## 测试

```bash
pnpm run ci                  # 成本规则 + 类型检查 + 全部单元测试 + 前端构建（和 CI 一样）
```

以下测试需要先运行 `wrangler dev`：

```bash
pnpm e2e                                     # 端到端：上传、处理、去重、zip 下载
pnpm smoke:processor                         # 只测容器
node scripts/perf/timeline-perf.mjs <目录>   # 5 万张照片的时间线性能（先灌入 scripts/perf/seed-50k.sql）
node scripts/perf/library-ui.mjs <目录>      # 文件夹、相册、回收站等界面流程
node scripts/perf/metadata-ui.mjs <目录>     # 编辑元数据与搜索
node scripts/perf/map-ui.mjs <目录>          # 地图（需要联网）
```

浏览器测试使用本机的 Chrome（无头模式），截图保存到指定的目录。

## 部署

推送到 `main` 后，由 Cloudflare Workers Builds 自动构建和部署：测试全部通过后，先执行 D1 迁移，再部署 Worker 和容器镜像。

第一次部署：fork 本仓库，在本机运行 `pnpm run setup`（创建资源、配置 Access、设置 secret，可以重复运行），再在 Cloudflare 后台把 Worker 连接到你的 fork，构建变量填 `NANA_DOMAIN`。步骤见 [docs/deploy.md](docs/deploy.md)。

你的域名和资源 ID 都不写进仓库文件，fork 和上游完全一致；以后在 GitHub 上点 **Sync fork** 就会自动迁移数据库并部署新版本。

## 已知限制

- 在 iPhone 上用 Safari 网页只能上传静态图片。完整的 Live Photo 需要在 Mac 的「照片」里导出未修改的原件，再上传。
- 超过 5 分钟或 2 GB 的视频不会转码，只保留原件（Safari 和 Mac 可以直接播放）。
- Live Photo 的动态部分不转码：Firefox 等不能解码 HEVC 的浏览器只显示静态照片。
- 视频暂时不能旋转。
- RAW 的处理路径还没有用真实相机文件测试过。
- 地图底图来自 OpenFreeMap：它能看到你浏览的地图范围（看不到照片），它不可用时地图页打不开，其他功能不受影响。

## 许可证

[AGPL-3.0](LICENSE)。修改后作为网络服务提供给别人使用时，必须向这些用户公开修改后的源码。

人脸识别用的 InsightFace 模型权重**只允许非商业使用**，不受 AGPL 覆盖（构建变量 `NANA_FACES=off` 可以完全不用它）；其他第三方组件见 [NOTICE](NOTICE)。

参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)，报告安全问题见 [SECURITY.md](SECURITY.md)。
