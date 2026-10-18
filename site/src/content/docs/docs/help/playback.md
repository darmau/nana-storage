---
title: 播放问题
description: 视频或 Live Photo 播放不了。
sidebar:
  order: 3
---

iPhone 拍的视频和 Live Photo 通常是 **HEVC（H.265）** 编码，不是所有浏览器都能解码。

| 内容 | 能解码 HEVC 的浏览器（Safari、Mac / Windows 上的 Chrome 和 Edge 等） | 不能解码的浏览器（比如 Firefox） |
|---|---|---|
| 普通视频（5 分钟 / 2 GB 以内） | 播原件 | 播转码好的 H.264 预览 |
| 普通视频（更长、更大） | 播原件 | 播不了，可以下载原件 |
| Live Photo 的动态部分 | 播放 | 只显示静态照片 |

Live Photo 的动态部分不转码：每张都转码会让处理费用翻倍，而它们只有几秒。

## 其他

- **HEIC 照片**在任何浏览器里都能看（显示的是处理好的 WebP 预览）；只有放大时叠加原图这一步，非 Safari 浏览器会改为在后台生成高清预览。见[浏览 › 加载原图](../../guide/browse/#加载原图hd)。
- 视频出错时会自动换下一个来源（原件 → H.264 预览）。
