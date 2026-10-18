---
title: 运行初始化
description: pnpm run setup 会做什么、每个提问怎么回答。
sidebar:
  order: 2
---

```bash
pnpm install
cd apps/worker && npx wrangler login && cd ../..
pnpm run setup
```

`wrangler login` 会打开浏览器让你授权 Cloudflare 账号。脚本的提示是英文的，可以重复运行，已经存在的东西会跳过。

## 它会问什么

| 提问 | 怎么答 |
|---|---|
| `Which account should it be deployed to?` | 账号有多个时才问，选你开通了 Workers Paid 的那个 |
| `Domain for the library` | 相册的域名，比如 `photos.example.com`，不带 `https://` |
| `The only email allowed to access the library` | 你自己的邮箱，**只有这个邮箱能登录** |
| `API token` | 用来自动建 Access 应用，见下文。直接回车就改为手动配置 |

## 它会做什么

1. **创建资源**（名字固定，已存在的跳过）：
   - D1 `nana-db`、R2 `nana-photos`、KV `nana-kv`
   - 队列 `nana-jobs`、`nana-jobs-dlq`
   - Vectorize 索引 `nana-embed`、`nana-faces`（512 维，cosine）
2. **执行 D1 迁移**。
3. **建 Zero Trust Access 应用**：覆盖整个域名、只放行你的邮箱、只用邮箱验证码（One-time PIN）登录、会话 24 小时，并打开 D1 读复制。
4. **写入 Worker secret**：`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`OWNER_EMAIL`。这一步会顺便建出一个空的 `nana-storage` Worker，下一步连接 GitHub 用的就是它。
5. 打印 Workers Builds 的设置。

## API 令牌

自动建 Access 应用需要一个临时的 API 令牌，**只在这次运行中使用，不保存**，用完就可以删掉。

在 [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) › 创建令牌 › 自定义令牌，给这几项权限：

- 账户 › Access: 应用和策略 › 编辑
- 账户 › Access: 组织、身份提供商和组 › 编辑
- 账户 › D1 › 编辑（可选，用来打开读复制）

粘贴时不会显示。

### 不想给令牌：手动配置

直接回车，脚本会打印步骤：

1. Zero Trust › Access › 应用程序 › 添加应用程序 › **自托管**，域名填 `photos.example.com`，路径留空。
2. 策略：操作“允许”，包含 › 电子邮件 › **只填你自己的邮箱**。
3. 登录方式：**只勾选 One-time PIN**。
4. 保存后复制应用的 **AUD 标签**，回到终端填入团队域名（`https://<团队名>.cloudflareaccess.com`）和 AUD。

D1 读复制可以之后在后台打开：D1 › `nana-db` › 设置 › Enable Read Replication。不打开也能正常用，只是所有查询都去主库。

## R2 保持默认

**不要**给 `nana-photos` 开启公开访问、r2.dev 子域名或自定义域名。所有照片字节都应该经过 Worker 校验身份之后流出。

## 缺少身份配置会怎样

三个 secret 少任何一个，Worker 会拒绝所有请求——宁可打不开，也不会在配置不全时放行。

下一步：[连接 Workers Builds](../workers-builds/)。
