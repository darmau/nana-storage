# Changelog

需要部署者手动操作的变更（新资源、新 secret、要重新运行 `pnpm run setup`）都写在这里，并标明 **需要操作**。

## 未发布

- 新增“相似照片”（探索页）：找出看起来差不多的照片（同一张图的各种版本、同一次拍摄里略有不同的几张），只看画面内容、不看拍摄时间，每组挑一张保留，其余移到回收站或归档，也可以“暂不处理”排到最后。用已有的 CLIP 向量和 Vectorize 索引，不增加容器时间；已有照片在打开页面时分批比较（每次打开最多 40 万张，页面要一直开着；或由每小时的 Cron 慢慢补上），30 万张的库补完一次约 $1 的 Vectorize 查询费用。补查时顺带补上重复照片的候选对：照片很多（超过 20 万张）时“重复照片”以前只检查了一部分，补完后就是全部。D1 迁移 `0025_similar_groups.sql` 只加表、列和索引，部署时自动执行，不需要操作。

- 设备端去掉“本机原件”（`compose.override.yaml` 把原图目录挂到 `/local`）：挂载的目录（比如 NAS）没连上时 Docker 启动不了。在设备界面（localhost:7878）上传的照片照旧直接用本机的那份、不下载原图；网页上传的照片由设备处理时从服务器下载。
  **需要操作**（用设备端处理、配过 `compose.override.yaml` 的）：删掉 `apps/device/compose.override.yaml`，再在 `apps/device` 下重新构建：`docker compose up -d --build`。

- 设备端处理更快：模型推理移到 worker 线程池（原来全部在主线程上排队，多核用不上），exiftool 改成常驻进程。
  12 核电脑上并发处理的吞吐约提高到原来的 2.4 倍，处理期间设备界面和上传也不再卡顿；处理结果和以前逐字节相同。
  云端容器同样改用常驻 exiftool（每个任务省约 50 毫秒容器时间），推理不变。
  **需要操作**（用设备端处理的）：在 `apps/device` 下重新构建：`docker compose up -d --build`。
- 设备界面上传更快：同时上传的条目从 2 个增加到 6 个（和网页上传相同）；暂存满了时先删掉最早的等本机处理的暂存文件（那些照片处理时照常下载原图），不再让上传等本机处理。
  **需要操作**（用设备端处理的）：在 `apps/device` 下重新构建：`docker compose up -d --build`。
- Live Photo 播放时带声音（浏览器不允许有声自动播放时退回静音；点 Live 按钮总是有声音），不需要操作。
- 主题可以指定范围：只在选中的几个文件夹（包括子文件夹）里查找和整理照片（主题页的“范围”）。D1 迁移 `0023_smart_set_folders.sql` 只加一列，部署时自动执行，不需要操作。
- 依赖小版本更新（React、TanStack、MapLibre、zod、wrangler 等），不需要操作。

## v0.1.0

首个公开版本。部署步骤见 [docs/deploy.md](docs/deploy.md)，官网和使用文档：<https://darmau.github.io/nana-storage/>（源码在 `site/`，由 `.github/workflows/site.yml` 发布到 GitHub Pages，fork 里不运行）。

- D1 的 `pin_lock` 表（迁移 `0009_pin_lock.sql`，PIN 锁已经去掉）这一版先保留，下一个版本删除，不需要操作。
