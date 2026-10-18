# Security Policy / 安全

nana-storage 的首要目标是：除了 `OWNER_EMAIL` 本人，任何人都不能以任何方式拿到照片。所以任何可能绕过这一点的问题都按安全漏洞处理，例如：

- 不经过 Cloudflare Access 或 `authenticate()` 就能读到照片、缩略图、元数据或静态资源；
- 跨站请求能触发写操作；
- 设备端处理接口（`/api/device/*`）能读到不属于当前任务的文件；
- 能让账单失控的路径（死循环、重试风暴、容器不休眠）。

**请不要公开提 issue。** 用 GitHub 的私密漏洞报告提交：仓库 → Security → Report a vulnerability。请附上复现步骤和影响范围，我会尽快回复。

Please report vulnerabilities privately via GitHub's "Report a vulnerability" (Security tab), not as public issues. Anything that lets someone other than the owner read photos, trigger cross-site writes, or cause runaway billing is in scope.

只有最新的发布版本会修复安全问题；用 Sync fork 或 `.github/workflows/sync-upstream.yml` 保持更新。
