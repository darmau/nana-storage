---
title: 部署失败
description: Workers Builds 常见的报错和解决办法。
sidebar:
  order: 1
---

部署失败**不会影响线上版本**：只有全部检查通过、迁移成功后才会切换到新代码。

## `Cannot generate the deploy config`

生成部署配置时按名字找不到某个资源（D1、KV、Vectorize 索引等），日志里写明了缺什么。通常是上游的新版本新增了资源。

在本机运行一次 `pnpm run setup`（会跳过已有的，只建缺的），再重试构建。

## `NANA_DOMAIN` 相关

构建变量里没有 `NANA_DOMAIN`，或者填了带 `https://` 的地址。只填主机名，比如 `photos.example.com`。

## 权限错误

Workers Builds 自动生成的令牌缺少权限。到 Worker › 设置 › 构建 › API 令牌，补上：

- D1 编辑（查 ID、执行迁移）
- Workers KV 存储 读取（查 ID）
- Workers 路由 / 域名 编辑（绑定自定义域名）
- 容器镜像推送（通常已经有）

## pnpm 安装失败

仓库要求的 pnpm 版本写在根目录 `package.json` 的 `packageManager` 里。构建环境装不上时，在构建的环境变量里指定 pnpm 版本。

## 测试失败

`pnpm run ci` 里的检查（成本规则、类型检查、测试、前端构建）在你的 fork 上失败，而你没有改过代码：多半是上游某个版本的问题，看一下上游仓库有没有新的修复，或者[提一个 issue](https://github.com/darmau/nana-storage/issues)。

## 部署成功但打不开

- **一直跳回登录页 / 403**：检查 Worker secret 里的 `OWNER_EMAIL` 和你登录用的邮箱完全一致，`ACCESS_AUD` 是这个 Access 应用的 AUD。可以重新运行 `pnpm run setup` 覆盖。
- **域名打不开**：确认域名在同一个 Cloudflare 账号里，Worker › 设置 › 域名和路由 里有你的域名。
- **页面白屏**：在浏览器开发者工具里看控制台报错，附在 issue 里。
