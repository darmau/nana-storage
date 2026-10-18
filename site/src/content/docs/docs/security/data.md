---
title: 数据存在哪里
description: R2、D1、KV、Vectorize 各存什么。
sidebar:
  order: 2
---

所有数据都在你自己的 Cloudflare 账号里：

| 存储 | 存什么 |
|---|---|
| R2 `nana-photos` | 原件（包括 RAW、Live Photo 的视频）、缩略图、预览、H.264 预览、人脸头像拼图、编辑用的底图 |
| D1 `nana-db` | 照片元数据（时间、位置、相机参数、描述）、文件夹、相册、处理任务、人脸框和人脸向量、人物和名字、指纹、主题、统计 |
| Vectorize `nana-embed` | 每张照片的 CLIP 向量，只有照片 ID，没有任何元数据 |
| Vectorize `nana-faces` | 每张脸的向量，只有脸的 ID |
| KV `nana-kv` | 打包下载的临时清单、少量配置 |
| Durable Object `UsageGuard` | 每天的用量记账、月度上限、熔断状态 |

D1 是唯一的真实数据；Vectorize 只是索引，查询结果一律再用 D1 过滤，丢了可以从 D1 重建。

## 日志

Workers 日志只记 ID，不记文件名、GPS、描述和人名。

## 外部服务

除了 Cloudflare，只有浏览器会请求 OpenFreeMap 的地图瓦片。处理照片的容器**断网运行**，模型在构建镜像时下载，固定版本和校验和。不调用任何 AI、地理编码或统计服务，没有遥测。

## 删除

- 删除的照片先进回收站，30 天后自动永久删除。
- 永久删除先删 R2 里的所有文件，再删 D1 的记录，并尽力删除向量。
