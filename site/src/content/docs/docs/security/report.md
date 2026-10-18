---
title: 报告安全问题
description: 发现漏洞时怎么联系。
sidebar:
  order: 3
---

**请不要公开提 issue。** 用 GitHub 的私密漏洞报告：仓库 › Security › [Report a vulnerability](https://github.com/darmau/nana-storage/security/advisories/new)，附上复现步骤和影响范围。

以下问题都按安全漏洞处理：

- 不经过 Cloudflare Access 或 Worker 的身份校验就能读到照片、缩略图、元数据或静态资源；
- 跨站请求能触发写操作；
- 设备端接口能读到不属于当前任务的文件；
- 能让账单失控的路径（死循环、重试风暴、容器不休眠）。

只有最新的发布版本会修复安全问题。用 Sync fork 或自动同步工作流保持更新，见[更新](../../deploy/updating/)。
