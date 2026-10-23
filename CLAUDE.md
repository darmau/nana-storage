# nana-storage

自托管的私人相册（类似 Google Photos），全部跑在 Cloudflare 上。单用户。

两条最高优先级的约束，任何改动都不能违反：

1. **安全**：除了 `OWNER_EMAIL` 本人，任何人都不能以任何方式拿到图片。
2. **成本**：不可能出现预期外的账单（死循环、重试风暴、容器不休眠）。

## 结构

- `apps/worker/`：唯一的 Worker。Hono API、静态资源、队列消费者、Cron、Durable Objects（`Processor` 挂载容器，`UsageGuard` 负责记账和熔断）。配置在 `wrangler.jsonc`，D1 迁移在 `migrations/`。
- `apps/processor/`：容器镜像，提供 `GET /health` 和 `POST /tasks/{name}`。处理代码在 `lib.mjs`，`server.mjs` 只是 HTTP 外壳。
- `apps/device/`：设备端处理，在主人自己的电脑上（Docker）代替容器处理，见下面“设备端处理”。不在 pnpm 工作区里。
- `apps/web/`：React SPA。
- `packages/shared/`：共享类型，以及**所有成本上限常量**（`limits.ts`）。

## 安全规则

- 每个请求（包括静态资源）都先经过 `authenticate()`（`src/auth.ts`）。不允许加入任何跳过鉴权的开关、环境变量或调试路由。
- `workers_dev` 和 `preview_urls` 必须保持 `false`。R2 不开公开访问、不发预签名 URL，所有字节都由 Worker 校验后流出。
- 图片响应只用 `Cache-Control: private`，不写入 Cache API 或 CDN。静态资源默认 `private, no-cache`；只有 `/assets/` 下带 hash 的 JS / CSS 是 `private, max-age=31536000, immutable`（`cacheHashedAsset()`，SPA 回退出来的 index.html 不算）。所有响应默认带 `Vary: Cookie`，只有照片字节（`/api/a/*`）和带 hash 的 JS / CSS 不带（`withSecurityHeaders()` 的 `varyCookie`）：Access 每次会话续期都会换 cookie，带着它浏览器会把缓存过的缩略图、预览全部作废重新下载。
- 前端不加载任何第三方资源，CSP 只允许 `'self'`。唯一的例外是地图底图：`connect-src` / `img-src` 放行 `https://tiles.openfreemap.org`，不放行脚本；照片相关的请求永远只走本站。
- 写请求要带 `X-Requested-With: nana`，并且是同源请求。
- 设备端处理（`apps/device`）用主人自己的 Access 登录（`cloudflared access token`，`cf-access-token` 头），走同一个 `authenticate()`，不允许为它加服务令牌或任何第二种身份。`/api/device/*` 只能读被认领、还在运行的任务的输入文件，只能写这个任务当前计划里的派生文件 key（key 带版本号，期间被旋转过就对不上）。设备界面的浏览和上传直接用和浏览器相同的接口（`/api/folders`、`/api/a`、`/api/uploads`），不加任何设备专用的接口。设备界面（`localhost:7878`）本身没有登录：设备登录过之后，能打开这台电脑 7878 端口的人都能浏览照片，这是主人接受的取舍（端口只绑定 127.0.0.1，校验 Host 头，写操作要带 `x-nana-device: 1`）。
- 日志里不记录文件名、GPS、描述，只记 ID。

## 成本规则（`pnpm check:cost-rules` 会做静态检查）

- **不使用 Durable Object alarm。** DO 只在收到请求时运行。
- **不使用 `@cloudflare/containers` 的 `Container` 类。** 它在容器运行期间会不断自我续期 alarm。改用原生的 `ctx.container`，再配合 `setInactivityTimeout`。
- **不使用 R2 事件通知。** 派生文件写回同一个桶会再次触发处理。
- **Worker 不请求自己的域名**，DO 之间不互相调用。
- **只有 `jobs.ts` 里的 `createJob` / `enqueueJob` / `requeuePending` / `retryFailed` 可以往队列里投递消息。** `requeuePending` 的自动调用只有设备端交还云端后的补发（`requeueAfterDevice`），其余都是用户点击。 队列消费者从不自己投递。`createJob` 入队失败时删掉刚插入的任务再抛错；上传完成（`complete`）用 `jobInsert()` 把“条目改成 pending”和“建任务”放进同一个 batch，再 `enqueueJob`，入队失败只记日志（任务留在 D1，“重新排队”可以补发）。创建上传时条目和上传记录也在同一个 batch 里写，不会留下空条目。D1 的 `jobs` 表是唯一的真实状态，每个任务最多尝试 `MAX_JOB_ATTEMPTS` 次。
- **只能通过 `processorStub(env, slot)` 获取 Processor**，`slot` 必须来自 `UsageGuard.acquireSlot()`，用完 `releaseSlot()`。池里固定只有 `PROCESSOR_POOL_SIZE`（32）个名字，Processor 也会拒绝在池外启动容器。同时运行几个容器由 `DEFAULT_PROCESSORS` 决定（4 个），设置页可以临时调高（`setProcessorsOverride()`，最长 7 天，到期自动回落，也可以提前结束：`clearProcessorsOverride()`）。队列 `max_concurrency` 等于 `PROCESSOR_POOL_SIZE`，多出来的消费者在 UsageGuard 里等槽位（最多 `SLOT_WAIT_MS`，不轮询），等不到就延迟重投，不算任务的尝试次数。延迟重投会消耗队列的 `max_retries`，所以它是 100（平台上限，`check:cost-rules` 只允许 ≤ 100）：太小的话，积压几千个任务时消息等槽位就耗光次数、进死信队列，任务永远停在 pending。重投不启动容器，同时最多 32 个消费者在等，每天最多约 7700 次。消息到达时任务正在运行（还没超过 `JOB_STALE_MS`）不 ack，而是延迟 `JOB_STALE_MS` 再看（`recheck`）：消费者中途被杀掉（部署、超时）后的重投靠它在过期后重新认领，否则任务永远停在 running。
- 容器：`enableInternet: false`，不允许 keepAlive，每个任务都有硬超时，超时就 `destroy()`。空闲 `CONTAINER_INACTIVITY_MS`（30 秒）后由运行时停止；任务结束时如果没有 pending 任务、`UPLOAD_ACTIVE_MS` 内也没有新建上传，消费者在归还槽位之前直接停掉容器（`stopIfIdle`）。队列消费者单次最多 15 分钟，转码超时不会超过任务剩下的时间（`RunningJob.deadline`），不够就跳过转码。
- 启动容器之前必须先 `UsageGuard.reserveJob()`，结束后调用 `recordContainer()` 记录实际时长。
- UsageGuard 只防失控，不限制正常用量：每天的容器时长 / 任务数 / 上传量只记账和显示。熔断条件只有两个：本月（UTC 自然月）容器的估算超额费用（`containerCost()`，扣掉免费额度、CPU 按满载算）达到月度上限（默认 `DEFAULT_MONTHLY_BUDGET_USD` = $10，设置页可改，范围 `MIN/MAX_MONTHLY_BUDGET_USD`，存在 UsageGuard 里不过期）；同一条目一小时内自动重试（任务的第 2 次及以后的尝试）超过 `MAX_RETRIES_PER_ASSET_PER_HOUR`（6）次，或者全部运行（包括旋转、加载原图、手动重试这些用户操作新建的任务）超过 `MAX_PROCESS_PER_ASSET_PER_HOUR`（30）次。Workers / DO / D1 / R2 按次计费的部分不熔断，由 `wrangler.jsonc` 的速率上限封顶；没有账户级的看门狗（要额外的 API 令牌，部署太复杂），改为上传面板估算这一批的容器费用（`upload/estimate.ts`：本月平均每个任务的容器时间 × 张数，任务太少时用默认值，费用是 `containerCost()` 的增量），会超过月度上限或超过 $1 时建议设备端处理；只读一次 `GET /api/guard`，不轮询。超过月度上限时 `POST /api/guard/resume` 返回 409，必须先调高上限。因为同一条目反复处理而熔断时，UsageGuard 记下条目 id（`trippedAssetId`），成本防护页列出它的全部任务（`GET /api/jobs/asset/:id`，最多 50 个，`settings/AssetJobs.tsx`），可以停止排队中 / 卡住的任务（`POST /api/jobs/cancel { ids }` → `cancelJobs`，记成 failed、`last_error = cancelled`，熔断时也允许，之后可以照常重试），再恢复。
- Cron 每次处理的数量都有上限，不会自我触发。
- 设备端处理：设备租约（`DEVICE_LEASE_MS`，2 分钟，记在 UsageGuard，没有定时器）有效时，消费者用 `UsageGuard.gate()` 得知后直接 ack，不占槽位、不启动容器，任务留在 D1 等设备认领；设备每次认领续租，空闲时每 `DEVICE_POLL_MS`（10 秒）一次，一直开着每天约 8640 次请求。设备交还云端时补发一批，设备突然消失时由每小时 Cron 补发（每次 `RESUME_BATCH`）。设备的任务同样走 `reserveJob()`（循环熔断）和 `MAX_JOB_ATTEMPTS`，熔断时不能接管；设备的处理时长不记入容器费用。
- 一个 process 任务最多调用容器：1 次 derive（指纹和人脸都在里面）+ 每个附件 1 次 meta + 最多 1 次 transcode（只有普通视频转码，Live Photo 的动态部分不转，浏览器不能解码 HEVC 时只显示静态照片）；它不创建新任务。rotate 任务（编辑：旋转 / 裁切 / 打码，“加载原图”）只有 1 次 derive。转码失败不会让任务失败（避免重试浪费），超过 `MAX_TRANSCODE_DURATION_MS` 的视频不转码。
- 重试也不会成功的错误（比如完整性校验失败）抛 `permanent: true`，直接失败。
- 前端：不允许 `refetchInterval`；重试和轮询都必须有次数或时间上限。
- 新增任何会持续或重复运行的东西（新的 Cron、队列、DO、循环、轮询）之前，先写清楚它的上限，以及它在最坏情况下每天的费用。

## 上传与处理流程

1. 没有单独的上传页。文件来自顶栏的“上传”菜单（在文件夹页面显示“上传文件到这个文件夹”；文件夹页自己不再放上传按钮）、文件夹卡片的右键菜单（都直接打开系统选择器，`upload/picker.tsx` 的 `pickUpload()`，必须在点击事件里同步调用；浏览器不能在一个选择器里同时选文件和文件夹，所以分两项），或者拖到任意页面（`upload/DropUpload.tsx`）。上传到哪里：文件夹页面是这个文件夹，其他页面都是根目录（`useUploadTarget()`）。选择或拖进来的文件夹按目录结构建子文件夹。浏览器配对文件（`apps/web/src/upload/group.ts`），在 Web Worker 里算 SHA-256，然后 `POST /api/uploads`（重复的直接返回 409）。
   读本地文件（算校验和、读分块）由 `upload/read.ts` 限流：同时最多 2 个，连续 60 秒读不到数据（NAS / 网络盘断开）就放弃并暂停整个队列，等用户点“继续”。卡住的读取会一直占着浏览器进程的线程、网页取消不了，占满后整个浏览器会卡死，所以不要放宽限流，也不要用 `<img>` / blob URL 读本地文件（上传面板不显示本地缩略图）。
2. 按 20 MB 分块 `PUT /api/uploads/:id/parts/:n`，分块先读进内存再发，重试不再读盘；失败时取消没传完的上传。第 1 块会按文件头校验类型（`src/sniff.ts`），不认识的直接拒绝。
3. 所有文件 complete 之后，条目变成 pending，`createJob(process)`。超过 `UPLOAD_ABANDONED_MS`（1 小时）还是 uploading 的条目算上传中断：文件夹页面列出它们的文件名；重新上传其中的文件时不算重复，旧条目（包括已经传完的文件）会被删掉，换成新条目。
4. 队列消费者调用 Processor DO，DO 从 R2 读原件交给容器。容器返回元数据、sha256、缩略图和预览，DO 把结果写回 R2。`src/process.ts` 负责校验完整性、解析 EXIF（`src/exif.ts`）、写 D1、合并 Live Photo、转码普通视频。
   进度：`GET /api/jobs/active`（`src/progress.ts`）返回这一批的完成数、最近 10 分钟的速度和正在处理 / 排队的任务（带文件名），显示在 `/settings/processing`；有任务时每 5 秒刷新，最多 120 次。资料库同步（`apps/web/src/library/sync.ts`）：上传和处理期间不用刷新页面，列表会自己更新。每 10 秒读一次 `GET /api/sync`（`data_version`：条目的任何变化都加一，包括上传和处理的中间状态；+ 是否还有 pending / running 任务，只读 2 行），版本变了才 `invalidateLibrary()`，最多每 30 秒一次；由打开应用、每传完一项、文件夹页看到正在处理的项触发，每次触发后最多检查 360 次（1 小时），没有上传、没有任务时立即停止，后台标签页不检查，出错即停。卡住或消息丢失的任务可以点“重新排队”（`POST /api/jobs/requeue` → `requeuePending`，熔断时拒绝；有排队或卡住的任务时一直显示；卡住的先发，其余按 `updated_at` 从旧到新，补发时把 `updated_at` 改成现在，连点会轮到下一批），也可以在列表里逐个停止排队中 / 卡住的任务（`cancelJobs`，之后在“处理失败”里重试）。失败的任务列在同一页（`GET /api/jobs/failed`，最近 `RETRY_FAILED_MAX` 个，带文件名），可以单个或全部重试（`POST /api/jobs/retry { ids }` → `retryFailed`，每次最多 `RETRY_FAILED_MAX` 个，只重新入队确实是 failed 的，熔断时拒绝）。
5. D1 读取：每个 `/api` 请求用一个 D1 会话（`src/dbcache.ts` 的 `openSession()`），可以读就近的副本（需要在后台打开读复制，见 `docs/deploy.md`）；前端 `api.ts` 把响应里的 `X-D1-Bookmark` 带回下一次请求，保证读到自己刚写的数据。会话只有 `prepare` / `batch`，API 代码里不要用 `env.DB.exec()` 之类的方法。列表接口（`conditionalGroups()` 名单）带 ETag = 部署版本 + 所依赖分组的版本号（`cache_versions`，迁移 0013 的触发器维护），没变就回 304，只读一两行。分组：`library`（时间线、地图、文件夹详情和列表、相册、收藏、归档、回收站、搜索；只在可见的条目（ready 或回收站里的）、相册、文件夹变化时加一，上传和处理的中间状态不改它）；`people`（人物列表 / 详情 / 照片 / 文件夹里的人物：people、faces 里影响结果的列、face_scans）和 `smart_sets`（主题列表 / 详情 / 样本 / 建议 / 结果），这两组同时带上 `library`。名单里只能放结果只取决于所依赖的表、和当前时间无关的接口；只是偶尔和时间有关的，那一次响应设 `Cache-Control: private, no-store`（`NO_STORE`），中间件就不给 ETag（主题正在更新时）。文件夹里还没处理完的条目和时间有关，单独走 `GET /api/folders/:id/unfinished`（不带 ETag，只读未完成的行，`assets_unfinished` 索引）。0011 的 `data_version` 只留给 `/api/sync`（迁移 0018 去掉了相册上的触发器，只跟着条目变）。因为有触发器，D1 的 `meta.changes` 会多算，计数一律用 `RETURNING`。
   **不收集统计信息**（不跑 `ANALYZE` / `PRAGMA optimize`，迁移 0019 删掉了 `sqlite_stat1`）：`deleted_at` 几乎全是 NULL，ANALYZE 会把 `deleted_at = ?` 估成几十行，规划器转而顺着 `assets_timeline` 每个文件夹扫一遍整个资料库（线上 4800 万行、26 秒）。列表查询靠部分索引、`INDEXED BY` 和 `CROSS JOIN` 固定执行计划，`test/query-plans.test.ts` 在没有统计信息和线上那份失真的统计信息下都检查一遍。
   查询计划：不能指望有统计信息（全新部署没有 `sqlite_stat1`）。没有统计时 SQLite 遇到 `ORDER BY taken_at DESC, id DESC` 会选 `assets_timeline`、逐行过滤，读完整个资料库。所以列表查询要么有形状完全一致的部分索引（`assets_folder_visible`、`assets_favorite_visible`，迁移 0018），要么写明 `INDEXED BY`（文件夹、地图），要么用 `CROSS JOIN` 从小的一边出发（连拍、人物、按人物筛选、文件夹详情的子树统计）。`test/query-plans.test.ts` 记下接口实际执行的 SQL，用 `EXPLAIN QUERY PLAN` 检查；新增列表查询时加进去。同一个请求里互不依赖的几条查询放进一个 `batch`（`/assets/:id`、`page()` 第一页的每月张数）。
   条目的状态不再写 `processing`（上传完是 `pending`，处理完是 `ready`；任务的 `running` 已经说明在处理），旧数据里可能还有，读取时和 `pending` 一样对待。
6. 文件读取：`GET /api/a/:id/:role`（`src/files.ts`），只用 private 缓存，支持 Range。带版本号 `v` 的派生文件（缩略图、预览）先按 `derivedKey()`（`src/derived.ts`）直接读 R2，不查 D1；读不到再查 D1。

## 设备端处理

- 目的：开着 Docker 时，上传的照片由主人的电脑处理，不启动 Cloudflare 容器。`apps/device/compose.yaml` 构建 `apps/processor/Dockerfile` 的 `device` 阶段（同一套依赖、模型和 `lib.mjs`；Cloudflare 构建最后一个阶段 `processor`）。界面在 `http://localhost:7878`（左边相册、右边正在进行的任务；设置是同一页面里的 `#settings` 视图，不跳转页面，否则正在发送的上传文件句柄会丢），端口只绑定 127.0.0.1，并校验 Host 头；写操作要带 `x-nana-device: 1`。
- 服务端（`src/device.ts`）：计划的 `derive` 带 `crop` 和 `mask`（打码，有打码时也要上传 `outputs.base`）。`claim` 原子认领（`CLAIMABLE_SQL`，和消费者同一个条件）并续租，每个任务返回计划（`planJob()`，和 `process.ts` 的两个 handler 一一对应）。设备下载输入、本地处理、上传派生文件，`complete` 时用 `precomputedProcessor()` 冒充 `ProcessorLike`，跑和容器路径**完全相同**的 handler（`processorHandlers`）；handler 实际的参数和计划不一致就返回 ok: false，任务退回 pending 重新处理，不会写错。认领凭证是 `jobs.started_at`（被别人重新认领后 409 `claim lost`）。收尾统一用 `settleJob()`。`release` 把没做完的任务退回且不算次数（设备正常退出时）。
- 设备端（`apps/device/main.mjs`）：启动自检（模型可读、vips / exiftool / ffmpeg 可用）通过才接管；默认启动时自动接管；连续失败 5 次自动交还云端；网络错误 10–60 秒退避；`docker compose stop` 时退回手上的任务并交还云端。界面的服务器队列走 `GET /api/device/queue`（只有计数和租约）。界面显示正在处理的照片：用本机刚生成的缩略图（`deriveTask` 的 `onStep`，不额外解码）；缩略图只在设备进程的内存里，最多保留最近 30 张。
- 本机文件（`runner.mjs` 的 `fromLocal`）：不挂载任何本机目录（NAS 没连上时 Docker 会因为挂载源不存在而启动失败，已经去掉），只用设备界面上传时的暂存文件。计划的每个输入带 `name` / `sha256`，按大小找暂存的候选（同名优先），复制到临时目录时算 sha256，对上了再请求 `GET /api/device/jobs/:id/input/:fileId/sha256`（Worker 用 `DigestStream` 对 R2 上的对象算一遍，代替下载后的完整性校验；只给不超过 `DEVICE_VERIFY_MAX_BYTES` 的文件 sha256），也对上才不下载。任何一步对不上或出错都照旧下载。流式下载用 `node:http(s)` 而不是 `fetch`（undici 在 body 暂停时遇到服务器关连接会断言失败，进程直接退出）。
- 设备界面的“相册”：和网页版一样浏览文件夹、子文件夹和照片，在哪个文件夹就上传到哪里（按钮或拖放，拖进来的文件夹按目录结构建子文件夹）。浏览只代理三个只读接口（`main.mjs` 的 `LIB_ROUTES`：文件夹详情、文件夹里的照片、缩略图，参数都校验，不是通用转发），只在打开、切换文件夹、加载更多和上传完成后（每 10 秒最多一次）请求，不轮询。
- 设备端上传（`apps/device/upload.mjs`）：网页只负责读文件：把清单交给设备程序，设备按需要逐个来要（`upload/next`），网页 `PUT /api/upload/file/:index` 把 File 流式推过去（同时最多 2 个）。设备分组（和浏览器共用 `packages/shared/src/group.ts`：这个文件不能 import、只能用可擦除的 TS 语法，设备端用 Node 直接加载，Docker 里按同样的相对路径放在 `/packages/shared/src/`）、边收边算 sha256，按和浏览器完全相同的协议调用 `/api/uploads`（409 重复、503 熔断时停下等用户点“继续”）。上传用的那份留在暂存目录（容器的临时目录，启动时清空）：设备在接管时，认领到这张照片的任务由 `fromLocal` 通过 `candidates()` 找到它（同样核对大小 + sha256，服务器再核对 R2 上的那份），复制走就删（`used()`），不下载原图；没接管时上传完就删。同时上传 6 个条目（和网页相同）。暂存上限 `STAGE_MAX_BYTES`（4 GB）/ `STAGE_MAX_GROUPS`（32），满了先删掉最早的等处理的暂存文件（`#evictReady()`，那些任务照常下载原图，上传不被本机处理速度拖住），只有还没上传完的就占满时网页才等，等处理的暂存文件 `STAGED_TTL_MS`（2 小时）后过期（任务照常下载）、交还云端时全部删除。文件句柄只在网页里，关掉网页剩下的文件发不了，界面提示重新选择或取消。
- 性能：`onnxruntime-node` 的 `run()` 在调用线程上同步执行，所以设备端把推理放进 worker 线程池（`apps/device/inference.mjs`，按 CPU 数 1–4 个 worker，经 `lib.mjs` 的 `setSessionFactory()` 接入；容器仍在本线程、1 个推理线程）。exiftool 是常驻进程（`lib.mjs` 的 `ExifTool`，`-stay_open`，容器 1 个，设备端 `setExiftoolProcs()`），读不了的文件按 JSON 里的 `Error` 判失败，和单独启动时的退出码一致。推理进行中不能 terminate worker（onnxruntime 会中止整个进程）。
- 架构：Cloudflare 的镜像是 linux/amd64，Apple Silicon 上的设备端是 arm64，onnxruntime 的 int8 计算略有差别：phash 完全一致，CLIP 余弦约 0.99（高于所有阈值，混用没有问题）。
- 本地开发：站点地址填 `http://host.docker.internal:8787`（http 只允许本地主机名，不需要登录）。

## 时间线与查看器

- `GET /api/timeline/buckets` 返回每月张数；`GET /api/timeline/month/:ym` 返回一个月的紧凑数组（`src/timeline.ts`）。
- 前端（`apps/web/src/timeline/`）外层按月虚拟化，月内只渲染视口上下 1200px 内的行。时间线的每个月和文件夹 / 相册等列表（`AssetGrid`）共用 `library/GridWindow.tsx`：渲染范围按 400px 取整（滚动不跨步长不重新渲染），二分查找行，离开范围的格子卸载。DOM 节点数和照片总数无关：5 万张时最多约 1100 个节点、100 个格子。改动布局或虚拟化之后，重跑 `scripts/perf/timeline-perf.mjs`。
- 右侧拖动条（`timeline/Scrubber.tsx`）：悬停、拖动或刚滚动过时露出半圆手柄。鼠标拖动时页面跟着滚；触屏拖动时只有手柄和月份标签跟着手指，松手才跳过去（iOS 上手指按着时用 `scrollTo` 滚页面，之后触摸事件的坐标会差出刚滚过的距离，页面在顶部和底部之间来回跳、一直是空白占位，不要改回去）。拖动期间时间线一个月份都不挂载、不请求经过的月份，列表容器的 `.scrub-placeholder` 背景（CSS 渐变画的格子）就是占位；松手后才加载停下的位置。快速滚动（`library/scrub.ts`：连续 2 次滚动事件超过每秒 8 个视口高度，降速 180ms 后恢复）同样处理，普通滚轮不会触发。拖动和悬停时不走 React：手柄、细线、月份标签直接改 `transform` 和文字，只在按下 / 松开时渲染；位置一律用 transform，不改 `top`、不对位置做过渡。有拖动条时 `<html>` 带 `has-scrubber`，整个 `<main>`（包括页头按钮）给它让出右侧位置。
- 列表也有拖动条（`library/ListScrubber.tsx`，至少 100 张、在窗口里滚动时才有；回收站按删除时间排序，没有）。只有相册、文件夹和主题的结果（`LibraryList` 的 `datedScrubber`）带年份刻度和月份标签；主题、人物、收藏、搜索、相似照片等其余列表只显示手柄（`Scrubber` 的 `dated={false}`），因为主题、相似照片的顺序不是拍摄时间，按顺序切出来的年份会大量重复。两种拖动条的占位、不走 React 等性能逻辑完全一样。不止一页时，第一页带回整个列表的每月张数（`page()` 的 `withMonths`，多一次聚合查询），没加载的部分按已加载部分每张的平均高度估算；不带日期的拖动条没有每月张数时只覆盖已加载的部分。拖动或快速滚动期间不加载，停下后一页一页补到停下的位置，请求数不超过总页数。
- 查看器顶栏：左边返回 + 拍摄时间（不显示地名，地名只能从地图瓦片里找），Live 按钮在返回下面；右边依次是加载原图（HD）、删除、收藏、编辑、信息（回收站里删除 / 收藏换成恢复，没有编辑）。信息面板打开后切换照片保持打开（新详情读到之前先显示上一张的）。
- 查看器打开的照片记在 URL 的 `?a=&m=` 里。照片先显示预览（长边 3840，`PREVIEW_LONG_EDGE`，覆盖 4K 和 iPad 全屏；缩略图和预览是 WebP，保留原图的 ICC 色彩配置、去掉其他元数据，像素不做色彩转换，所以 Display P3 的照片在广色域屏幕上颜色完整）；屏幕实际需要的物理像素超过预览时（主要是放大），停留 0.4 秒后叠加原图（只限浏览器能解码的格式，HEIC 只在 Safari 上加载，原图不超过 40 MB / 6000 万像素），用 CSS 转到和预览相同的角度。
- “加载原图”（查看器顶栏的 HD 按钮，`hdPlan()` in `viewer/media.ts`）：预览已经覆盖原图分辨率时只提示“已经是最高清”；浏览器能解码的原件（同上的格式和大小限制）直接叠上去，不经过容器；其他的（非 Safari 的 HEIC、RAW、超过 40 MB / 6000 万像素的）`POST /api/assets/:id/full-preview`，按原图分辨率重新生成预览并**替换**原来的预览（`assets.preview_target` 记下尺寸，`fullPreviewEdge()`：不超过原图、6000 万像素和 WebP 的 16383 上限），走 rotate 任务（1 次 derive，`FULL_PREVIEW_TIMEOUT_MS`），前端每 2 秒查一次、最多 100 次，生成好后用带 `&hd=` 的新地址叠上去。全尺寸预览不走 base64 JSON：容器把 JSON 和预览字节接在一起返回（`x-preview-transport: stream`），DO 用 `splitStream()` 把预览直接流进 R2。
  成本：每张照片最多生成一次（生成过 `preview_edge` 就达到上限，不会再触发；已有排队 / 运行中的任务不重复建），只由用户操作触发，熔断时拒绝；单次约 10–60 秒容器时间，仍受月度费用上限约束。全尺寸预览比普通预览大几倍（几 MB 到十几 MB），存储和读取流量相应增加。
- 切换时按上一次切换的方向预加载前方两张的预览，反方向一张（刚打开时按往后算；同一地址不重复请求），预加载时用 `decode()` 提前解码。已经下载并解码过的预览（`Viewer.tsx` 的 `ready`）切换过去直接同步显示，不再先露出模糊缩略图；没有的才垫一张按照片尺寸放大的缩略图。时间线跨月时会提前读相邻月份。
- Live Photo 打开时自动播放一次、桌面悬停再播放，都带声音（浏览器不允许有声自动播放时退回静音，`Still` 的 `play()`；Live 按钮用 `flushSync` + `useLayoutEffect` 在点击当时调用 `play()`，iOS 上也有声）；查看器顶栏只有一个 Live 按钮（照片上不再另放标志）：点一下播放一次，长按 / 右键切换自动播放（`ui/liveAutoplay.ts`，这台设备的 localStorage，默认打开），图标表示自动播放是否打开。
- 视频优先播原件（浏览器能解码 HEVC 时），否则播 H.264 预览，出错就换下一个来源。单击照片进入沉浸模式（隐藏所有按钮和信息面板，切换照片时保持），再单击恢复；等 250ms 排除双击。
- 限速：普通 API 用 `API_LIMITER`（3000/分钟），`GET /api/a/*` 用 `FILE_LIMITER`（6000/分钟）。缩略图加载失败只重试一次。

## 资料库

- `src/library.ts`：文件夹（只能删除空文件夹；移动时禁止移进自己的子树；封面取整棵子树里最近拍的最多 9 张，满 9 张拼九宫格、4–8 张拼四宫格、更少只显示一张；查询不能对递归 CTE 写相关子查询，否则几百个文件夹时要几十秒；卡片离视口 600px 以外时卸载图片）、相册、收藏、回收站、`POST /api/assets/batch`（每次最多 1000 个）。列表接口统一返回 `{ items, next }`，按偏移量分页，每页 500 条。
- 文件夹的列表视图（页头按钮切换，这台设备的偏好 `ui/folderView.ts`）：子文件夹一行一个（图标 / 名称 / 子文件夹数 / 文件数 / 体积 / 上次修改，体积和上次修改在 `/folders/:id` 原来的子树统计里一起算），照片走 `GET /api/folders/:id/assets?view=list`（多返回 `details`：文件名 / 原件大小 / 拍摄时间 / 时区 / 上传时间），`library/AssetRows.tsx` 按固定行高虚拟化，选择、右键菜单、拖动条和网格相同。文件名和原件大小冗余在 `assets.file_name` / `file_size`（迁移 0014，由 `asset_files` 上的触发器维护），列表不再查 `asset_files`。
- 文件夹里照片的排序（页头的排序按钮，这台设备的偏好 `ui/folderView.ts` 的 `useFolderSort()`，所有文件夹共用）：拍摄时间（默认，从新到旧）/ 文件名 / 上传时间 / 尺寸（原件大小）/ 格式（扩展名，SQL 里从 `file_name` 截取），可以选方向。接口参数 `?sort=&order=asc`（`library.ts` 的 `folderOrder()`），默认的不带参数。只有“拍摄时间从新到旧”和 `assets_folder_visible` 的顺序一致，其余照样按这个索引读出本文件夹再临时排序，不加索引（每页读一遍本文件夹的行）；最后都按 id 排，分页顺序确定。只有按拍摄时间排序时网格按天分组、拖动条带年份 / 月份（`withMonths`）。子文件夹不受影响。
- 归档（`assets.archived`，迁移 0024）：归档的照片不出现在时间线（首页，按月张数也不算）、文件夹和相册里，文件夹 / 相册卡片的张数、体积和封面也不算；文件夹 / 相册页勾选“显示归档照片”（地址的 `?archived=1`，`useShowArchived()`，接口同名参数）时才列出。集中在归档页（`/archive`，`GET /api/archive/assets`，部分索引 `assets_archived_visible`，侧边栏和资料库首页有入口）。搜索、地图、人物、主题、收藏、连拍页照常显示。操作走 `POST /api/assets/batch { action: "archive", value }`，多选栏 / 右键菜单里：普通列表只有“归档”，显示了归档照片的列表两种都有（`BarContext` 的 `withArchived`），归档页只有“取消归档”。
- 永久删除只能删已经在回收站里的条目（`deleteAssetsPermanently`，先删 R2 再删 D1；除了 `asset_files` 里的文件，还按当前版本号删掉派生文件的 key，任务失败时写下的文件没有记录）。D1 的 `meta.changes` 会把级联删除的行也算进去，不能拿它当计数。
- 批量下载（`src/downloads.ts` + `src/zip.ts`）：zip 只存储不压缩，CRC32 由容器在处理时算好并存在 `asset_files.crc32`，Worker 只转发字节，`Content-Length` 也能事先算准；需要时自动使用 ZIP64。`test-node/zip.test.ts` 用 python zipfile 和 `unzip -t` 校验输出。
- 前端：`library/` 下是多选（勾选框 / 长按 / Shift 点击）、操作栏（手机上只露出收藏 / 加入相册 / 下载 / 删除，其余用 `max-sm:hidden` 隐藏、收进“更多”菜单，按钮仍在 DOM 里）、通用列表网格；查看器通过 `ViewerNav` 接入不同数据源（时间线按月，列表按已加载的页）。
- 幻灯片（`apps/web/src/viewer/Slideshow.tsx`）：文件夹 / 相册页头的“幻灯片”按钮，和网格共用分页查询。顺序播放快到末尾才加载下一页，随机播放逐页加载全部（最多 200 页，一次一个请求，出错即停）；每张只请求一次预览，间隔最短 3 秒；视频跳过。
- 界面流程测试：`node scripts/perf/library-ui.mjs <截图目录>`。大列表压力测试：`node scripts/perf/library-stress.mjs <截图目录> <列表路径>...`（一直滚到底，记录 DOM 节点数、JS 堆和长任务）。

## 连拍与照片类型

- `assets.burst_id`：Apple 的 `BurstUUID`，或者 `groupBurst()`（`src/process.ts`）按拍摄间隔推断的组（`t:` 前缀）。推断条件是同一台相机、同样尺寸、间隔在 (0, 500ms] 以内，所以只有带亚秒时间的照片才会被分组。后处理的照片会把两边已有的推断组合并。
- 时间线把一组连拍折叠成一张封面（收藏的优先，否则最早的一张），条目的第 9 项是整组的 id。按月张数也按组计算。格子点开进入 `/bursts/:id`（`GET /api/bursts/:id/assets`），选择、右键菜单、按天全选、Shift 范围选择都作用于整组。其他列表（文件夹、相册、搜索）不折叠。
- `assets.traits` 位标志（`TRAIT`）：1 全景（全景投影标签，或者相机拍的、长宽比 ≥ 2）、2 长曝光（曝光 ≥ 1 秒）、4 人像（景深图 / 人像遮罩的标签）、8 RAW（有 raw 附件）。都在 process 任务里识别，没有额外的容器调用。搜索页按 `type` 参数筛选。
- 类型筛选：`ASSET_TYPES`（shared）= 照片 / 视频 / Live Photo（`assets.kind`）+ 连拍 / 全景 / 长曝光 / 人像 / RAW，服务端的条件统一由 `typeCondition()`（`src/library.ts`）生成。文件夹和相册页头下有横向的筛选条（`library/TypeFilter.tsx`，单选，再点一次取消），记在地址的 `?type=` 里（`listSearch`），列表、幻灯片、拖动条都按筛选后的结果；不认识的值当作没有筛选。

## 元数据编辑与搜索

- `PATCH /api/assets/:id`：拍摄时间（拍摄地本地时间 + 时区偏移）、位置、描述、旋转、裁切、打码。编辑过的字段会写进 `meta_locked` 位标志（1 时间 / 2 位置 / 4 描述），process 任务重新处理时不会覆盖它们。
- 批量修改走 `POST /api/assets/batch`：`set-time`（统一设成同一时刻）、`shift-time`（整体平移，在 SQL 里按各自的时区重算 `local_day`，没有拍摄时间或平移后超出范围的不改，时区未知的用浏览器时区补上）、`set-location`。同样写 `meta_locked`。每条语句 80 个 id，D1 单条语句最多 100 个参数。
- 编辑（查看器顶栏的编辑按钮，`viewer/Editor.tsx`）：旋转、裁切和打码，**只改缩略图和预览，原件不动**。保存时一次 PATCH `{ rotation, crop, mask }`，之后用底图 + CSS（打码另叠一层 canvas）显示编辑结果（`EditPreview`），等后台生成好（每 2 秒查一次、最多 30 次）再换上新图。有任务在跑时不能编辑（底图可能还是旧的）。
  - 只用 `rotate` 任务重新生成缩略图和预览（1 次 derive，不重读元数据、不转码），预览按 `preview_target`（换过全尺寸预览的保持原图尺寸）生成。已经有排队中的 rotate 任务时不再新建；任务运行时读取最新的角度、裁切和版本号，发现版本已过时就丢弃结果。视频不能编辑。
  - 裁切框存在 `assets.crop_x/y/w/h`（迁移 0017，0–1 的比例，相对于旋转之后、裁切之前的整张图；都为 NULL 表示没有裁切；shared 的 `crop.ts`）。只改角度时框跟着转（`rotateBox()`），和角度一起提交时按新的角度理解；覆盖整张图的框存成 NULL。`width` / `height` 仍然是裁切之前的尺寸（加载原图、信息面板、连拍判断都用它），列表接口返回裁切后的尺寸（`timeline.ts` 的 `ITEM_COLUMNS` + `toItem()`，网格按它排版）。
  - 容器（`x-crop` 头）先缩放、旋转，再裁切预览、从裁切后的预览生成缩略图；另外把旋转之后、裁切之前的整张图缩到长边 2048 存成底图（`d/{id}/base-{rev}.webp`，role `base`），编辑界面用（没有裁切、打码时直接用预览）。底图不记在 `asset_files` 里（role 有 CHECK 约束，改它要重建整张表），只能带版本号读；rotate 任务写完后按前缀列一次 R2 删掉其他版本的底图，永久删除时随 `DERIVED_FILES` 一起删；`storage_totals` 不算它。设备端的计划带 `crop` / `mask`，有裁切或打码时多上传一个 `outputs.base`。
  - 查看器里叠在预览上的“整张图”（原图、Live 视频）用 `Framed` 按角度和裁切框摆到和预览重合、裁掉框外；人脸圈按 `cropFaceBox()` 换算，框外的不画。
  - 打码（毛玻璃）：笔画存在 `assets.mask`（迁移 0021，shared 的 `mask.ts`：base64url 的 uint16 数组，坐标是相对于**旋转之前**的整张图的 0–1 比例，和人脸框同一个方向，旋转、裁切都不用换算；半径是长边的比例；最多 `MASK_MAX_POINTS` 个点，前端涂抹结束时用 RDP 简化）。笔刷大小固定（屏幕上 20px 半径），没有设置；有撤销和全部清除。容器（`x-mask` 头，`apps/processor/mask.mjs`）在未旋转的预览上打码再旋转、裁切：毛玻璃（盒式模糊 3 遍 + 固定种子的随机错位）和蒙版都在长边 1024 的小图上用 JS 算，放大回原尺寸后 `ifthenelse --blend` 混合（原图在前，ICC 保留）；指纹和人脸照样按没打码的图算。前端 `viewer/frost.ts` 是同一个算法，编辑时实时预览。有打码时同样输出底图（不打码）。容器和设备端都在结果里原样带回 `mask`，对不上（旧版镜像 / 设备端忽略了打码）时任务失败、不写入没打码的图（设备端已经上传的会删掉）。成本：只在用户保存打码时多一次 rotate 任务里的打码步骤，3840 的预览约多 1 秒容器时间，全尺寸预览约多 4–10 秒。
  - 打码盖住的脸（人脸框被盖住 `MASK_FACE_COVER` 以上，`maskCoverage()`）：`faces.masked = 1`，移出人物、`state = 3`、删掉向量，信息面板不列出，不能手动指定（`applyMaskToFaces()`，PATCH 时立即生效；扫描时 `saveFaces` 也会判断）。去掉打码后改回待识别，由每小时的 Cron 补写向量、重新归入（原来手动指定的人物不保留）。
- `assets.preview_edge` 记录预览生成时的长边，查看器据此判断是否需要叠加原图、是否已经是最高清。改大 `PREVIEW_LONG_EDGE` 后旧照片不会自动重做。
- 派生文件只有在实际文件属于 URL 里的版本时才标记为 immutable（旋转后新图生成之前，新版本号对应的仍是旧图）。
- 搜索 `GET /api/search`：FTS5 trigram，查询词 ≥3 个字符走索引，1–2 个字符退回 LIKE（已转义 `%` 和 `_`）；查询词整体作为短语传给 MATCH，避免 FTS 语法注入。
- 界面测试：`node scripts/perf/metadata-ui.mjs <截图目录>`（可以重复运行）。

## 地图

- 底图用 OpenFreeMap（`apps/web/src/map/style.ts`，浅色 positron / 深色 dark），免费、不要 key、自动更新，不需要维护任何地图数据。浏览器直接请求它，它能看到 IP 和浏览的地图范围，看不到照片。样式 JSON 取回后把地名换成界面语言（`style.ts` 的 `NAME_FIELDS`：中文取 `name:zh-Hans`，英文取 `name:en` / `name_int`，都没有用当地文字），信息面板找地名也用这组字段。
- `src/map.ts`：只提供照片点位和列表。照片在服务端按网格聚合，格子大小由前端按视口宽度计算（约 80 像素一格），所以返回的点数大致固定（最多 1000 个）。
- 前端（`apps/web/src/map/`）：CJK 字符用系统字体在本地渲染（`localIdeographFontFamily`），不下载 CJK 字形。地图库约 1.1 MB，按需加载。
- 查看器信息面板：有位置的照片显示小地图（`map/MiniMap.tsx`，不可拖动，深色底图，换照片时复用同一个地图）和地名。地名不调用任何地理编码服务，从已经加载的瓦片的 `place` 图层里找：城镇按 city / town / village / hamlet 从大到小、各自限定距离取最近的，再加 4 km 内最近的片区，找不到就只显示经纬度。打开信息面板时 OpenFreeMap 会看到这张照片附近的瓦片坐标（和地图页同样的取舍），看不到照片。
- 界面测试：`node scripts/perf/map-ui.mjs <截图目录>`（需要联网）。

## 相同 / 相似照片

- 指纹在 process 任务的那 1 次 derive 里一起算（`apps/processor/lib.mjs`），不增加容器调用：`phash`（64 位感知哈希）和 CLIP ViT-B/32 图像向量（512 个 int8，模型权重在构建镜像时下载，固定版本和校验和，容器仍然断网）。都按用户旋转之前的图像计算，rotate 任务带 `x-fingerprint: skip` 不重算。容器算失败时 `fp` 为 null，不影响任务。换模型时同时改 `MODEL_VER` 和 shared 的 `FP_MODEL_VER`。
- D1 绑定 BLOB 参数只传 `ArrayBuffer`（`blobOf()`）：线上 D1 会把 `Int8Array` / `Uint8Array` 存成逗号分隔的文本（本地模拟器不会）。修复之前写入的 `embedding` 都是这种文本，读取时兼容（`asInt8()` / `decodeClassifier()`），不需要重算。
- D1 的 `asset_fp` 是唯一真实数据。Vectorize（`EMBED_INDEX`，`nana-embed`）只存 asset_id 和向量，不放元数据；查询结果一律再用 D1 过滤（回收站、未就绪的去掉）。写入失败时 `indexed = 0`，由每小时的 Cron 补写（`syncVectors`，每次最多 `VECTOR_SYNC_BATCH`，熔断时跳过）。永久删除和 Live Photo 合并时尽力删向量。本地没有 Vectorize：相关接口返回 `unavailable: true`。
- 重复照片（`GET /api/duplicates`）：phash 拆成 5 段（13+13+13+13+12 位）存在 `b0..b4`，距离 ≤ `DUPLICATE_MAX_HAMMING`（4）的一定有一段相同。候选对存在 `duplicate_pairs`（迁移 0016），写指纹时（`saveFingerprint` → `savePairs`）按 5 段索引查近邻（每张最多 `DUPLICATE_NEIGHBOR_MAX` 个）增量维护，只存不会变的条件（哈希距离、照片 / 视频、向量余弦）；打开页面只读候选对，再按连拍、拍摄时间、回收站、“不是重复”过滤后并查集分组，读取量和照片总数无关。部署前的指纹由第一次打开时全量补建一次（`rebuildDuplicatePairs`，最多读 `DUPLICATE_SCAN_MAX` 行，完成后写 `duplicate_pairs_state`；增量维护失败时删掉这一行，下次打开再补）。视频和照片不互比，同一组连拍不算重复。phash 只看 32×32 的明暗，同一场景连拍的几张也会落在距离以内，所以还要：两张都有相机 EXIF 时拍摄时间相差 ≤ `DUPLICATE_SAME_CAPTURE_MS`（整刻钟的差算时区丢失，改过时间的不比），两张都有向量时余弦 ≥ `DUPLICATE_MIN_COSINE`（在写候选对时判断，全量补建时最多读 `DUPLICATE_EMBED_MAX` 张的向量）。
- “不是重复”：`duplicate_ignores`（a < b 的照片对，随条目级联删除），`POST /api/duplicates/ignore` / `unignore`（`{ ids, pivot? }`，最多 `DUPLICATE_IGNORE_MAX` 张；有 pivot 时只记它和其他每一张）。前端点开一组进入 `routes/DuplicateCompare.tsx`：几张叠在同一位置，←/→ / 数字键 / 滑动切换，点击放大且切换时保持位置，↑/↓ 换组。
- 相似照片：`GET /api/assets/:id/similar`，Vectorize 前 30 个、余弦 ≥ 0.85，排除同一组连拍。查看器信息面板只在打开时请求。这是 Vectorize 唯一的查询方，主题不用它。
- 主题（`smart_sets` / `smart_set_examples` / `smart_set_suggestions`，后端在 `src/similar.ts`，前端 `routes/SmartSetPages.tsx`）：按被摄内容浏览（狗、汽车…）。每个主题是 CLIP 向量上的逻辑回归分类器（`src/smartset-model.ts`，正例、反例加上全库随机抽的 `SMART_SET_BACKGROUND` 张背景，固定步数，权重存在 `smart_sets.weights`），分数 p 在 0–1。**分类器只负责建议**，照片放进哪个相册由用户在“结果”里手动挑，所以样本保持小规模（最多 `SMART_SET_MAX_EXAMPLES` 个）。
  - 页面三个标签：样本（正例 / 反例混在一个网格里，反例压暗，角上 ✓ / ✕，矛盾的再加警告标记，`Page.marks` → `Tile` 的 `TileMarks`；选中后设为正例 / 反例 / 移出样本）、判断（建议，默认分类器最拿不准的在前（分数最接近“标准”档），多选“是 / 否”或 `SmartSetReview` 逐张 Y / N）、结果（`GET /assets`：正例 + 分数达到灵敏度的建议，按拍摄时间，可以排除已在某个相册里的，多选后加入相册或“不属于这个主题”）。其他页面的“加入主题”可以选正例或反例。
  - 标记样本（`POST /api/smart-sets/:id/examples`，label 1 / -1 / 0 移出）只写 D1、更新 `labels_changed_at`，不重新训练；界面提示“更新”。用户点了就 `POST /refresh`，否则每小时的 Cron 自动更新（`refreshStaleSmartSets`：标记停止变化 `SMART_SET_CRON_QUIET_MS` 之后、有正例的，每次最多 `SMART_SET_CRON_BATCH` 个，熔断时跳过；没变化的主题不重跑）。更新的过程：训练 + 直接扫描 D1 全库（不用 Vectorize），p ≥ `SMART_SET_SUGGEST_FLOOR` 的保留前 `SMART_SET_SUGGESTION_MAX` 条（用 `json_each` 一条语句写一大批）。同一主题同时只跑一次（`refreshing_until` 锁，过期自动失效）。5 万张时每次约 5 万行 D1 读取、最坏约 8 万行写入。
  - 质量：正例、反例都至少 `SMART_SET_CV_MIN` 张时做 `SMART_SET_CV_FOLDS` 折交叉验证（6 次训练，最坏约 1 秒 CPU），每档灵敏度的“认出正例 / 排除反例”比例存在 `smart_sets.metrics`；每张样本的分数（`smart_set_examples.score`，交叉验证时是没见过它的模型打的分，手动加入时先用当前模型打一次）和标签矛盾的（`SMART_SET_CONFLICT`）在样本里标出来。标记时正好在建议里的照片记下当时的分数（`review_score`），算每档的实测准确率。`train` 列已经不用（新写入的都是 1），留着只因为旧代码还在读；迁移 0015 清空了改版之前的主题。
  - 范围（`smart_sets.folders`，迁移 0023：JSON 的文件夹 id 数组，最多 `SMART_SET_MAX_FOLDERS` 个，NULL 是整个资料库）：`PATCH /api/smart-sets/:id { folders }`，只留还存在的文件夹，改了就立即更新一次。每次读取时用递归 CTE 展开成整棵子树（`scopeOf()`，不和条目相关），新建的子文件夹、移进来的文件夹都算。更新时只给范围里的照片打分（样本不论在哪都用来训练，背景仍从全库抽）；新照片只在范围里才打分；建议、结果、各档张数在读取时也按范围过滤（正例也是，`in_scope`），所以移出范围的照片不用等下次更新。前端：主题页头下的“范围”行 + `FolderScopePicker`（`library/Pickers.tsx`）。
  - 灵敏度（`SMART_SET_SENSITIVITY`）只是按分数筛选，不重新训练。新照片处理完后用每个训练过的主题（最多 `SMART_SET_MAX` 个）打一次分，够像的进建议，不读全库。
- 成本：Vectorize 按维度计费，5 万张约 2560 万存储维度，查询只由用户操作触发，每月在免费额度内或几美分。每张照片多约 0.3–0.5 秒容器时间。

## 人物（人脸识别）

- 交互参照 iOS 相册 / Google 相册：人物就是一组同一个人的脸（`people`），名字可以为空（界面上显示“添加名字”）。
- 人脸在 process 任务的那 1 次 derive 里一起算（`apps/processor/faces.mjs`），不增加容器调用：SCRFD 检测（640 输入）+ 5 点对齐 + ArcFace 512 维向量（InsightFace buffalo_l，Immich 导出的 ONNX，固定版本和校验和；权重只允许非商业使用）。在长边 1920 的图上算，按用户旋转之前的方向，rotate 任务不重算；视频不算。每张照片的所有头像横向拼成一张 WebP（`face_scans.sprite_key`，`d/{id}/faces-{rev}.webp`），只能带版本号读（`/api/a/:id/faces?v=`），永久删除时一起删。换模型时同时改 `FACE_MODEL_VER`（processor 和 shared）。构建参数 `NANA_FACES=off`（Workers Builds 的构建变量 → `render-wrangler.mjs` 写进容器镜像的 `build_vars`；设备端是 compose 的同名变量）时镜像不带人脸模型，`lib.mjs` 的 `FACES_ENABLED` 为 false，`faces` 恒为 null（`saveFaces` 直接返回，不写任何数据、不重试）：权重只允许非商业使用，给不能接受的部署者用。
- 表：`faces`（框、`px`、置信度、清晰度、向量、`person_id`、`assigned` 0 无 / 1 自动 / 2 手动、`state` 0 待识别 / 1 推迟 / 2 完成 / 3 不参与、`masked` 被打码盖住）、`face_scans`（每张照片一行，没有脸也有，表示扫描过；同一模型扫描过的重新处理时保留，不覆盖用户的修改）、`face_rejects`（“这不是 X”）。
- 归入人物（`src/people.ts` 的 `recognizeFace`，类似 DBSCAN）：Vectorize `FACE_INDEX`（`nana-faces`，只存 face_id 和向量，结果一律用 D1 过滤）查最像的 `FACE_MATCH_TOP_K` 张，余弦 ≥ `FACE_MATCH_MIN` 算像；自己加上像的 ≥ `FACE_CORE_MIN` 张是核心：附近有人物就归入（附近的脸按人物投票，相似度相加；否认过的人物里的脸不算附近的脸），没有就新建未命名人物，并把附近没有人物的脸一起归进来。不是核心、附近也没人物的推迟，`FACE_DEFER_MS` 后由每小时 Cron 再看一次（`recognizePendingFaces`，每次最多 `FACE_CRON_BATCH`，同时补写没进索引的向量、删掉空的未命名人物，熔断时跳过）。太小（`FACE_MIN_PX`）或置信度低（`FACE_MIN_SCORE`）的脸只记录不归入。手动指定（assigned = 2）和 `face_rejects` 永远优先，自动处理不会改掉。“这不是 X”（`/people/:id/remove`、`/faces/:id/reject`）之后脸改回待识别（assigned = 0），当场重新识别最多 `FACE_REJECT_RECOGNIZE_MAX` 张（熔断时跳过），其余由 Cron 处理，不会归回 X，通常归到本来该是的那个人（迁移 0022 把以前移出来的脸也改回待识别）。并发处理可能把同一个人建成两个人物，靠用户合并。
- 接口：`GET /api/people`（未命名的至少 `PEOPLE_MIN_ASSETS` 张才列出；个人收藏在前）、`/people/:id`、`/people/:id/assets`（和相册一样分页、`?type=`、每月张数）、`PATCH /people/:id`（名字重复返回 409 `name taken` + 对方 id，前端问要不要合并；封面用 `coverFaceId` 或 `coverAssetId` 指定，`null` 恢复自动挑选：手动确认过的、最大最清楚的脸）、`/people/:id/merge`、`/people/:id/remove`（“这不是 X”，同时记 reject）、`/people/:id/reassign`（“这是其他人物”：`{ assetIds, personId | name }`，算手动指定，同时记 reject）、`/people/:id/review`（“确认更多照片”：用最多 `FACE_REVIEW_SEEDS` 张脸查 Vectorize，只在打开时请求）、`GET /assets/:id/faces`、`POST /faces/:id/assign | reject`。`GET /api/folders/:id/people`（文件夹页顶部的人物条，`people/FolderPeople.tsx`：只看本文件夹、不含子文件夹，一次请求；不列隐藏的，未命名的按全库张数过 `PEOPLE_MIN_ASSETS`，最多 40 个，count 是本文件夹里的张数；点头像按人物筛选，记在地址的 `?person=`（`folderSearch`），照片走 `GET /api/folders/:id/people/:personId/assets`（单独的路径，ETag 带 `people` 版本），筛选时多选栏 / 右键菜单和人物页一样（“这不是 X”“这是其他人物…”），直接改认错的脸；右键头像打开人物页）。列表、详情、照片和文件夹人物（含按人物筛选的照片）这几个 GET 带 ETag（`library` + `people` 版本），其余不带。
- 前端：`routes/PeoplePages.tsx`（`/people`、`/people/:id`；人物页选中照片后只有“这不是 X”和“这是其他人物…”，右键菜单另有“设为人物封面”）、`people/`（头像 `FaceAvatar` 用 `<img loading="lazy">` 平移拼图、按照片旋转角度转过来；`PersonPicker`；`ReviewDialog` 一次一张、Y / N）、查看器信息面板的“人物”（点脸：查看、设为封面、添加名字、改成其他人、这不是 X）；人物页照片的右键菜单有“设为人物封面”。从人物页打开查看器时（`Viewer` 的 `personId`），照片上用圆圈标出归为这个人物的脸（`FaceRings`，复用 `GET /assets/:id/faces` 的查询，框按 `rotateFaceBox()` 换算到预览的角度；沉浸模式下隐藏）。
- 隐私：人脸向量和人名只在 D1 / Vectorize 里，不调用任何外部服务；日志里不记人名。
- 成本：每张照片多约 0.3 秒 + 每张脸约 0.1–0.2 秒容器时间；每张脸 1 次 Vectorize 查询。5 万张照片约 5–10 万张脸，Vectorize 费用很低。本地没有 Vectorize：只记录人脸，不归入。

## 统计数据

- 页面 `/stats`（`routes/StatsPage.tsx`，探索下的入口；旧地址 `/settings/usage` 跳过去），从上到下：概览、拍摄时间、拍摄设备、最大的文件、存储、费用、容器时长、增长。柱状图统一用 `ui/BarChart.tsx`。
- 拍摄时间 / 拍摄设备（`src/library-stats.ts`）：不实时。每天的 Cron（`17 3 * * *`，回收站清理之后）用 3 条聚合查询统计一次，存成 `library_stats` 一行 JSON（迁移 0020）；`GET /api/stats/library` 只读这一行，还没有时（全新部署）现算一次。最近 `LIBRARY_STATS_DAYS` 天的每日张数（“一年内”在前端按 52 周汇总）+ 所有时间的每月张数（跨度超过 120 个月时按年显示）+ 设备（最多 `LIBRARY_STATS_CAMERAS` 个）。只算可见条目，连拍逐张计，日期是拍摄地本地日期。每天约 3 × 条目数的行读取 + 1 行写入。
- 最大的照片 / 视频：`GET /api/stats/largest/:kind`（photo = photo + live 两条合并），实时，走部分索引 `assets_size`（迁移 0020），每种 kind 只读前 `LARGEST_MAX` 行，带 ETag（`library`）。返回列表视图的格式，前端直接用 `LibraryList view="list"`（查看器、多选、删除都能用）。
- `GET /api/stats`（`src/stats.ts`）：条目数、各类文件的容量（原图 = original + raw + live_video，回收站和未完成的上传单列）、D1 大小、Vectorize 向量数、本月和最近 30 天的容器时长 / 任务 / 上传量（`UsageGuard.history()`，每日用量保留 62 天）、按上传月份的增长。
- 费用估算只算应用自己能算出来的：套餐费、R2 / D1 存储、容器、Vectorize、队列。请求数、R2 操作、D1 读写行数不估算（不调用 GraphQL Analytics，部署时不需要额外的令牌）。单价和免费额度在 `packages/shared/src/pricing.ts`（`estimateCost()`），价格变了改这里。费用项的显示名称按 `CostKey` 放在前端语言文件的 `usage.costLines` 里，新增费用项时两边都要加（类型检查会提醒）。
- 只在打开页面和点“刷新”时请求，不自动刷新；每次约 25 万行 D1 读取（5 万张时）+ 1 次 UsageGuard 请求。
- 侧边栏底部 / 资料库首页（移动端）的存储空间（`library/StorageMeter.tsx`）走轻量的 `GET /api/stats/summary`：只读 `storage_totals` 一行（迁移 0013 的触发器维护：`asset_files` 全部文件（包括缩略图、预览、回收站）的字节数 + 处理好的照片（含 Live Photo）/ 视频数），不扫表，不查 UsageGuard。`/api/stats` 全量统计时顺手比对，对不上就用一条语句重新统计。打开应用时请求一次，之后只随 `invalidateLibrary()` 刷新（上传期间最多每 30 秒一次），不轮询。

## 界面设计

- 颜色、尺寸都是 `apps/web/src/styles.css` 里的 token（`bg-bg`、`bg-card`、`text-muted`、`bg-accent`、`text-accent-fg` …），组件里不直接写色值。`@theme inline` 让 `.theme-dark` 子树（查看器）可以强制深色。
- 布局尺寸变量：`--header-h`、`--sidebar-w`（md 以上的侧边栏）、`--tabbar-h`（移动端底部标签）。固定定位的东西（地图页、时间线拖动条、多选操作栏）都按这些变量避让。这三个变量已经包含安全区（刘海 / Home 指示条），其他贴边的元素用 `--safe-top/bottom/left/right`，不直接写 `env()`。
- 导航：搜索框只有一个：桌面在顶栏（`SearchBox`，输入就跳到 `/search?q=`），移动端顶栏没有，放在探索页里（`md:hidden`）。侧边栏的“探索”小标题就是探索页（`/search`）的入口，下面是人物、主题（`/smart-sets`）、地图、统计数据（`/stats`）；移动端底部标签是 照片 / 相册 / 探索 / 文件夹 / 资料库：“探索”在 `/search`、`/people`、`/smart-sets`、`/map`、`/duplicates`、`/stats` 下都高亮（移动端的地图、重复照片和统计数据从探索页进入），面包屑“探索 › 主题”；“文件夹”在所有 `/folders/*` 下高亮。资料库首页（`routes/LibraryHome.tsx`）只放别处没有的入口：收藏、回收站和存储空间（文件夹有自己的标签，人物、重复照片在探索页里，不重复放）。
- 探索页（`routes/SearchPage.tsx`）：没有搜索词和筛选时是入口页：人物、主题卡片（`SmartSetStrip`，不用 `ul li`，见下面的脚本钩子）、地图、重复照片和统计数据、按类型。有搜索词或筛选时显示结果。
- 设置（`apps/web/src/routes/settings/`）：`SettingsLayout` 外壳 + 分页（概览 / 后台处理 / 成本防护；使用统计已搬到 `/stats`）。分页之间切换只淡入淡出（`ui/motion.ts`），不从右推入。语言是下拉框。lg 以上左侧是分页导航；窄屏时概览页就是目录，分页标题旁有返回按钮（`SettingsHeader`）。概览只在打开和点“刷新”时请求，不自动刷新。
- 外观（跟随系统 / 浅色 / 深色）是这台设备的偏好，存在 localStorage（`ui/theme.ts`），由 `<html data-theme>` 生效；`public/theme.js` 在渲染前同步套用（CSP 不允许内联脚本），`dark:` 变体也跟着它走。新增深色相关的样式时，`styles.css` 里两处深色变量都要改。“关于”的版本号由 `vite.config.ts` 注入（`WORKERS_CI_COMMIT_SHA`，本地读 git）。
- PWA：`public/manifest.webmanifest` + `index.html` 里的 iOS meta。manifest 也要鉴权，所以 `<link rel="manifest">` 必须带 `crossorigin="use-credentials"`。没有 Service Worker（不在浏览器里缓存任何照片）。全屏深色界面用 `ui/themeColor.ts` 的 `useThemeColor()` 临时改状态栏颜色；断网 / 登录过期由 `ConnectionBanner` 提示并提供重新加载（独立窗口里没有刷新按钮）。独立窗口里有自己的下拉刷新（`ui/PullToRefresh.tsx`，系统的下拉刷新被 `overscroll-behavior: none` 关掉了）：页面在顶部时下拉过阈值松手，`invalidateQueries()` 重新请求当前页面的数据（连接已中断时整页重新加载）；固定定位的东西（查看器、弹窗、地图、拖动条）、touch-action: none 和没滚到顶的滚动区域里不触发，刷新期间不接受新的下拉。图标由 `favicon.svg` 的图案渲染而来，改图标时一起更新几张 PNG。
- 加载态：首次加载时照片网格（`LibraryList`）、时间线、相册列表、根目录的子文件夹、人物列表显示骨架屏（`ui/Skeleton.tsx`，纯 CSS 块，`.skeleton` 延迟 150ms 淡入，缓存命中时不闪；照片网格复用 `.scrub-placeholder` 的格子图案）。启动画面是 `index.html` 里 `#root` 外的 `#splash`（内联 Logo + 进度条，`.app-splash`），独立窗口里立即显示、普通标签页延迟 300ms，`Layout` 第一次渲染后由 `ui/splash.ts` 的 `hideSplash()` 淡出移除。
- 图标只用 `apps/web/src/ui/icons.tsx` 里的内联 SVG（Live Photo 一律用和 iOS 一样的 `IconLive`，不写“LIVE”文字），不用 emoji 或 Unicode 符号，也不引入图标库或 Web 字体（CSP 只允许 `'self'`，地图底图除外）。
- 需要确认的操作（删除、永久删除等）用 `apps/web/src/ui/confirm.tsx` 的 `confirmDialog()`（`[role="alertdialog"]`，能叠在查看器上），输入名称用 `promptDialog()`，报错用 `alertDialog()`，不用原生 `confirm()` / `prompt()` / `alert()`。
- 多语言（简体中文 / English，`apps/web/src/i18n/`）：界面文案一律写进 `zh-CN.ts`（源语言）和 `en.ts`，代码里用 `t.xxx` / `t.xxx(n)`，不在组件里写死文案；`en.ts` 声明成 `Messages`，少一条或参数不对都过不了类型检查。带数字的文案写成函数，英文单复数在函数里处理；数字用 `fmtNumber()`，不用 `toLocaleString()`。语言是这台设备的偏好（localStorage `nana:lang`，默认按浏览器语言），加载时确定一次，切换时重新加载页面，所以 `t` 是普通的模块级值，非组件代码也能用。被 Web Worker 导入的文件（如 `upload/read.ts`）不引用 `t`，错误由主线程翻译。`pnpm check:i18n --strict`（CI 里会跑）按语法树检查，`apps/web/src` 里除了 `i18n/` 和测试文件，字符串、模板和 JSX 文本都不能出现中文（注释不算）。`scripts/perf/*.mjs` 靠中文文案定位元素，所以都先把 `nana:lang` 设成 `zh-CN`。
- 服务端的错误码保持英文（`{ error: "..." }`），前端 `api.ts` 按 `t.api.codes` 把它翻译后放进 `ApiError.message`（原始错误码在 `code`）；界面上显示错误一律用 `errorText()`，不要 `String(error)`。新增错误码时在两个语言文件的 `api.codes` 里各补一条。动效类（查看器进出 / 切换、弹窗 `sheet-in`、菜单 `menu-in`、多选栏 `bar-in`、信息面板 `panel-in` …）在 `styles.css` 末尾，只动 opacity / transform，系统开启“减少动态效果”时全部关闭（新增动效类时加进那个媒体查询）。
- 页面切换用 View Transitions（`ui/motion.ts`，路由的 `defaultViewTransition`）：进入下一层从右推入，后退 / 回上一层反向，顶层页面之间淡入淡出；只改地址参数（查看器 `?a=`、筛选 `?type=`）不做动画。浏览器不支持带类型的 View Transition 时整个关掉。顶栏、侧边栏、底部标签有 `view-transition-name`，不跟着页面动；新增顶层页面时加进 `TOP`。
- `scripts/perf/*.mjs` 依赖这些钩子，改界面时要保留：格子是 `div.group`，里面最后一个按钮是 `aria-label="选择"` 的勾选框；查看器是 `[role="dialog"]`，信息面板是其中的 `aside`；相册 / 文件夹卡片是 `ul li a` 加 `div.truncate` 名称；多选栏的按钮文字（加入相册、移动、下载、删除 …）必须是页面上第一个以该文字开头的按钮。


## 部署

- 只有一个 Worker，配置在 `apps/worker/wrangler.jsonc`（根目录没有 wrangler 配置，这是有意的）。Workers Builds 的根目录设为 `apps/worker`，命令先 `cd ../..` 回到仓库根目录。
- 推送到 `main` 后由 Cloudflare Workers Builds 自动部署：`pnpm run ci`（成本规则 + 类型检查 + 全部测试 + 前端构建）通过后，再运行 `pnpm run deploy`（生成部署配置 → D1 迁移 → `wrangler deploy`）。一次性配置见 `docs/deploy.md`（`pnpm run setup`）。
- 开源项目，别人 fork 后部署。`wrangler.jsonc` 是模板，**不写任何部署者的信息**（域名、资源 ID）：`scripts/render-wrangler.mjs` 在部署时用构建变量 `NANA_DOMAIN` 和按名字查到的 D1 / KV ID 生成 `wrangler.deploy.json`（不进仓库），迁移和部署都用 `-c wrangler.deploy.json`。部署者的 fork 和上游保持零差异，靠 Sync fork 更新，所以不要加需要部署者改仓库文件才能用的配置。新增资源（新的 Vectorize 索引、队列等）时，同时改 `scripts/setup.mjs`（创建）、`render-wrangler.mjs`（能查的话提前报缺失）和 `CHANGELOG.md`（写明要重新运行 `pnpm run setup`）。新增必需的 secret 同理。
- 身份信息（`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`OWNER_EMAIL`）是 Worker secret，不写进仓库。
- **迁移会在新代码部署之前执行**，所以每个迁移都必须兼容当前线上的旧代码：只能加表、加列、加索引；要删除或改名旧代码还在用的列时，分两次部署。部署者可能一次跳过很多版本，所以删列的迁移至少隔一个发布版本（tag），并写进 `CHANGELOG.md`。

## 开发

```bash
pnpm install
cd apps/worker
cp .dev.vars.example .dev.vars   # 本地的身份配置
npx wrangler d1 migrations apply nana-db --local
npx wrangler dev          # 本地模拟，不要用 --remote
pnpm test
pnpm check:cost-rules     # 在仓库根目录运行
```

端到端测试（需要 Docker，`wrangler dev` 会在本地构建并运行容器）：

```bash
cd apps/web && npx vite build          # wrangler 的 assets 目录需要存在
cd apps/worker && npx wrangler dev     # 另开一个终端
node scripts/e2e-upload.mjs            # 在仓库根目录运行
cd apps/processor && sh test/smoke.sh  # 只测容器
cd apps/device && NANA_SITE=http://host.docker.internal:8787 docker compose -p nana-device-e2e up -d --build   # 设备端代替容器，再跑一次 e2e
```

前端开发：在 `.dev.vars` 里设 `APP_ORIGIN=http://localhost:5173`，然后在 `apps/web` 下运行 `npx vite`（`/api` 会代理到 8787）。
