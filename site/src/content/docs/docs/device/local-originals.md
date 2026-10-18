---
title: 本机原件
description: 原图还在本机或 NAS 上时，不再从服务器下载。
sidebar:
  order: 2
---

通过网页上传的照片，如果原件还在这台电脑上（或者它能访问的 NAS 上），可以把这些目录**只读**挂进容器。处理时读本机的文件，不再从服务器下载原件。

```bash
cd apps/device
cp compose.override.example.yaml compose.override.yaml
```

编辑 `compose.override.yaml`，换成你自己的目录（可以挂多个，都放在 `/local` 下面）：

```yaml
services:
  device:
    volumes:
      - /Users/me/Pictures/Export:/local/export:ro
      - /Volumes/NAS/Photos:/local/nas:ro
```

然后 `docker compose up -d --build`。`compose.override.yaml` 不进仓库，更新代码不会覆盖它。Docker Desktop 默认能访问 `/Users` 和 `/Volumes`。

## 怎么找到对应的文件

- 启动时在后台建索引：只记文件大小和名字，**不读内容**。界面显示索引了多少个文件。找不到时最多每 5 分钟重新扫描一次，新复制进来的文件也能找到。
- 按大小找候选，同名的优先，改过名的也行（比如从「照片」导出时重命名了）。
- 复制到临时目录时算 SHA-256，和上传时记录的一致才用。
- 用之前，服务器还会在 Cloudflare 内部对 R2 里那份算一次 SHA-256：如果上传时读盘出错，本机文件是好的、R2 里那份是坏的，必须发现。
- 超过 2 GB 的文件服务器不做这个校验（Worker 的 CPU 时间有限），总是下载。
- **任何一步出错都改为下载**，本机文件永远不会让任务失败。
