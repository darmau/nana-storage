---
title: 连接 Workers Builds
description: 让 Cloudflare 从你的 fork 自动测试、迁移和部署。
sidebar:
  order: 3
---

推送到 `main` 后，Cloudflare **Workers Builds** 会自动：类型检查、测试、成本规则检查 → 全部通过后执行 D1 迁移 → 部署 Worker 和容器镜像。

## 连接仓库

Cloudflare 后台 › Workers 和 Pages › `nana-storage` › 设置 › 构建 › **连接 Git 仓库**，按提示授权 Cloudflare 的 GitHub App（建议只授权这一个仓库），选择你的 fork。

## 构建配置

| 设置 | 值 |
|---|---|
| 生产分支 | `main` |
| 根目录 | `apps/worker` |
| 构建命令 | `cd ../.. && pnpm install --frozen-lockfile && pnpm run ci` |
| 部署命令 | `cd ../.. && pnpm run deploy` |
| 构建变量 | `NANA_DOMAIN` = `photos.example.com` |
| 非生产分支构建 | **关闭** |

可选的构建变量：`NANA_FACES` = `off` 关闭人脸识别，见[可选配置](../options/)。

### 为什么这样配

- 仓库是 pnpm monorepo，唯一的 Worker 配置在 `apps/worker/wrangler.jsonc`。Workers Builds 要求根目录指向配置文件所在的目录，并且用里面的 `name`（`nana-storage`）核对后台的 Worker，所以 Worker 必须叫这个名字。
- 依赖要在仓库根目录安装，所以两条命令都先 `cd ../..`。
- 前端构建产物 `apps/web/dist` 通过 `assets.directory` 随 Worker 一起部署，不需要 Pages。
- 非生产分支构建只上传代码版本、不更新容器镜像，而预览地址（`preview_urls`）本来就关闭，开着只会白跑。如果界面要求填非生产分支的部署命令，保留默认的 `npx wrangler versions upload`，再把开关关掉。

## 第一次构建

点“重试构建”或者推一个提交触发。第一次要构建容器镜像（下载模型等），比之后慢。注意看日志：

- **pnpm 版本**：仓库要求的 pnpm 版本写在根目录 `package.json` 的 `packageManager` 里。构建环境装不上时，在构建的环境变量里指定 pnpm 版本。
- **令牌权限**：Workers Builds 自动生成的令牌要能列出 D1 / KV（按名字查 ID）、执行 D1 迁移、推送容器镜像、绑定自定义域名。某一步报权限错误时，到构建设置里给令牌补上 D1 编辑、KV 读取、Workers 路由 / 域名权限。
- 构建环境里没有 `python3` 或 `unzip` 时，zip 格式校验测试会跳过（日志里有提示），不影响部署。
- 在“生成部署配置”这一步失败（`Cannot generate the deploy config`）时，日志会写明缺少哪个资源，在本机再运行一次 `pnpm run setup`。

更多见[部署失败](../../help/deploy-errors/)。

构建成功后，按[部署后检查](../checklist/)确认一遍。
