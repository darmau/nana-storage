---
title: 部署后检查
description: 确认只有你能打开、照片能正常处理。
sidebar:
  order: 4
---

## 安全

- [ ] 用**无痕窗口**打开 `https://photos.example.com`：先跳到 Access 登录页，用邮箱验证码登录后能正常使用。
- [ ] 不带 cookie 请求接口，被 Access 拦下（跳转到登录页或 403），拿不到任何数据：

  ```bash
  curl -i https://photos.example.com/api/me
  ```

- [ ] `nana-storage.<你的子域>.workers.dev` 打不开（`workers_dev: false`）。
- [ ] R2 › `nana-photos` › 设置：公开访问是关闭的，没有 r2.dev 子域名和自定义域名。
- [ ] Zero Trust › Access › 应用程序：策略只包含你自己的邮箱。

## 功能

- [ ] 上传几张照片，在 设置 › 后台处理 里看到任务完成，时间线里出现照片。
- [ ] 设置 › 成本防护 里的容器时长有合理的增长；任务结束后容器会停止。
- [ ] 地图页能显示底图和照片的位置。
- [ ] 打开一张照片的信息面板（快捷键 `i`），能看到“相似照片”；Workers 日志里没有 `vectorize_query_failed` / `vectorize_upsert_failed`。
- [ ] 探索 › 主题、重复照片页能打开。

## 建议

- 在 Cloudflare 账单里设预算告警，见[可选配置](../options/)。
- 想自动跟随上游更新，见[更新](../updating/)。
- 有很多照片要导入，先看[费用](../../costs/)和[设备端处理](../../device/install/)。
