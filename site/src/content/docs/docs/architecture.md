---
title: 架构
description: 一个 Worker、几种 Cloudflare 存储和一个处理容器。
---

```
浏览器 ──> Cloudflare Access（邮箱验证码，只放行一个邮箱）
             │
             ▼
        Worker：nana-storage
          ├─ Hono API + React 前端（静态资源）
          ├─ D1         元数据、任务、人脸、统计
          ├─ R2         原件、缩略图、预览
          ├─ KV         下载清单、部分配置
          ├─ Queue      后台处理任务
          ├─ Vectorize  相似照片和人脸的向量索引
          ├─ Durable Object: Processor  ──> Container（libvips / exiftool / LibRaw / ffmpeg，无外网）
          ├─ Durable Object: UsageGuard     用量记账与熔断
          └─ Cron       每小时补写索引等、每天清理回收站和统计
```

## 一张照片的旅程

1. **上传**：浏览器在本地算出文件的 SHA-256（重复的直接跳过），按 20 MB 分块上传到 R2。第一块会按文件头检查类型，不认识的格式直接拒绝。
2. **排队**：所有文件传完后，条目变成“待处理”，任务进入队列。D1 里的 `jobs` 表是唯一的真实状态，每个任务最多尝试 3 次。
3. **处理**：队列消费者从 UsageGuard 领一个容器槽位（默认同时 4 个），Processor 把原件交给容器。容器一次完成：读元数据、生成缩略图和长边 3840 的预览（WebP，保留色彩配置）、算指纹（感知哈希 + CLIP 向量）、检测人脸。普通视频再转码成 H.264。
4. **写回**：结果写回 R2 和 D1，向量写进 Vectorize。容器空闲 30 秒后自动停止。
5. **浏览**：所有字节都由 Worker 校验身份后流出，只用 `Cache-Control: private`，不进 CDN。

如果开着[设备端处理](../device/install/)，第 3 步改由你自己的电脑完成，不启动云端容器。

## 为什么这样设计

- **一个 Worker**：部署、权限、配置都只有一份。前端、API、队列消费者、定时任务都在里面。
- **容器而不是 Worker 里处理**：HEIC、RAW、视频需要 libvips、LibRaw、ffmpeg，Worker 里跑不了。容器按秒计费，处理完就停。
- **没有会自己运行的东西**：不用 Durable Object alarm、不用 R2 事件通知、Worker 不请求自己。所有重复运行的东西（Cron、轮询、重试）都有写明的上限。见[费用](../costs/)。

## 代码在哪

| 目录 | 内容 |
|---|---|
| `apps/worker/` | Worker：API、队列消费者、Cron、Durable Objects、D1 迁移 |
| `apps/web/` | React 前端 |
| `apps/processor/` | 处理容器的镜像（`lib.mjs` 是处理代码） |
| `apps/device/` | 设备端处理（Docker） |
| `packages/shared/` | 共享类型和所有成本上限常量 |
