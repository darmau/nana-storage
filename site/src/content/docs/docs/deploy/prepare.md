---
title: 准备
description: 部署之前需要的账号、域名和工具。
sidebar:
  order: 1
---

部署一共三步：**fork 仓库 → 运行初始化脚本 → 连接 Workers Builds**。整个过程大约 15–30 分钟，只需要做一次。

:::note
本页和仓库里的 [`docs/deploy.md`](https://github.com/darmau/nana-storage/blob/main/docs/deploy.md) 内容一致，两边以仓库为准同步更新。
:::

## 1. Cloudflare 账号

- 开通 **Workers Paid**（$5 / 月）：Workers 后台 › 套餐。Containers 只在付费套餐里可用。
- 在 **Zero Trust** 里选一个计划，免费的就够（只有你一个用户）。第一次打开 Zero Trust 时会让你起一个团队名，比如 `myteam`，之后的登录地址是 `https://myteam.cloudflareaccess.com`。

## 2. 域名

域名要托管在同一个 Cloudflare 账号里（DNS 由 Cloudflare 解析）。决定一个子域名给相册用，比如 `photos.example.com`——下文都用它代替。

不需要提前建 DNS 记录，部署时会自动绑定。

## 3. 代码

1. 在 GitHub 上打开 [darmau/nana-storage](https://github.com/darmau/nana-storage)，点 **Fork**。
2. 把你的 fork clone 到本机：

   ```bash
   git clone https://github.com/<你的用户名>/nana-storage.git
   cd nana-storage
   ```

3. 本机需要 **Node 24** 和 **pnpm**（仓库指定了 pnpm 版本，`corepack enable` 后会自动使用）。

**不需要改仓库里的任何文件。** 你的域名、邮箱和资源 ID 都不写进仓库：域名是 Workers Builds 的构建变量，资源 ID 在部署时按名字查，身份信息是 Worker secret。所以你的 fork 和上游完全一致，以后点 Sync fork 就能更新，不会有冲突。

下一步：[运行初始化](../setup/)。
