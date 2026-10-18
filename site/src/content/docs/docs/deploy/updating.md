---
title: 更新
description: 跟随上游的新版本。
sidebar:
  order: 6
---

## 手动更新

在 GitHub 上打开你的 fork，点 **Sync fork**。Workers Builds 会自动跑测试、执行新的 D1 迁移、部署新版本。

## 自动更新

仓库自带一个工作流 `Sync upstream`（`.github/workflows/sync-upstream.yml`），每周把你的 `main` 快进到上游最新的发布版本（`v*` tag）：

1. 在你的 fork 的 **Actions** 页面启用工作流（fork 默认不运行 Actions）。
2. 想跟随上游的 `main` 而不是发布版本：Settings › Secrets and variables › Actions › Variables，加一个 `NANA_SYNC_REF` = `main`。

它只做快进：

- 你的 `main` 上有自己的提交时会失败并提示，需要手动合并。
- 上游的新版本改了 `.github/workflows` 下的文件时，GitHub 不允许工作流推送这些文件，这一次会失败，手动点一次 Sync fork 即可。

## 跳过版本

可以。每个数据库迁移都兼容上一个版本的代码（迁移在新代码部署之前执行），删除旧列至少隔一个发布版本。直接从很旧的版本同步到最新也没问题。

## 需要手动操作的更新

偶尔上游会新增资源（比如新的 Vectorize 索引）或 secret。这些都写在 [CHANGELOG.md](https://github.com/darmau/nana-storage/blob/main/CHANGELOG.md) 里，标明 **需要操作**。

漏看了也不要紧：部署会在“生成部署配置”这一步失败，日志写明缺少什么（线上版本不受影响）。在本机运行一次 `pnpm run setup` 再重试构建。

用[设备端处理](../../device/install/)的话，更新后在 `apps/device` 下重新构建：`docker compose up -d --build`。
