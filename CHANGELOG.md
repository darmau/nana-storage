# Changelog

需要部署者手动操作的变更（新资源、新 secret、要重新运行 `pnpm run setup`）都写在这里，并标明 **需要操作**。

## 未发布

- 设备端处理更快：模型推理移到 worker 线程池（原来全部在主线程上排队，多核用不上），exiftool 改成常驻进程。
  12 核电脑上并发处理的吞吐约提高到原来的 2.4 倍，处理期间设备界面和上传也不再卡顿；处理结果和以前逐字节相同。
  云端容器同样改用常驻 exiftool（每个任务省约 50 毫秒容器时间），推理不变。
  **需要操作**（用设备端处理的）：在 `apps/device` 下重新构建：`docker compose up -d --build`。
- 依赖小版本更新（React、TanStack、MapLibre、zod、wrangler 等），不需要操作。

## v0.1.0

首个公开版本。部署步骤见 [docs/deploy.md](docs/deploy.md)，官网和使用文档：<https://darmau.github.io/nana-storage/>（源码在 `site/`，由 `.github/workflows/site.yml` 发布到 GitHub Pages，fork 里不运行）。

- D1 的 `pin_lock` 表（迁移 `0009_pin_lock.sql`，PIN 锁已经去掉）这一版先保留，下一个版本删除，不需要操作。
