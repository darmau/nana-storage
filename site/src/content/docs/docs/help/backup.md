---
title: 备份、导出与迁移
description: 怎么把照片和元数据拿出来。
sidebar:
  order: 4
---

数据都在你自己的 Cloudflare 账号里，随时可以拿出来。Cloudflare 的存储本身有冗余，但**防不住误操作和账号问题**，重要的照片建议在别处再留一份。

## 按文件夹下载（带原文件名）

在文件夹或相册里全选 › 下载，打包成 zip，文件名就是上传时的原文件名，Live Photo 的视频和 RAW 附件一起打包。每次最多 1000 张。

适合：把一部分照片拿出来、分享给别人、换到别的相册软件。

## 整桶备份 R2（全部原件）

用 [rclone](https://rclone.org) 把整个 R2 桶同步到本地硬盘或 NAS：

1. Cloudflare 后台 › R2 › 管理 API 令牌 › 创建令牌，权限选**对象读**，只给 `nana-photos` 这一个桶。记下 Access Key ID、Secret Access Key 和端点地址。
2. `rclone config` 新建一个远程，类型选 S3，提供商选 Cloudflare，填上面三项。
3. 同步：

   ```bash
   rclone sync r2:nana-photos /Volumes/Backup/nana-photos --progress
   ```

R2 没有流量费，下载只按读取次数计费（每张照片几次）。

R2 里的文件名是 ID（原件在 `o/<照片 ID>/<文件 ID>`，`d/` 下是缩略图和预览），要和下面的 D1 备份放在一起才能还原出文件名和元数据。这是用来“万一出事”的完整备份。

## 备份 D1（元数据）

D1 的元数据（时间、位置、描述、文件夹、相册、人物、编辑）是那时自己的数据，最重要的保护是 D1 自带的 **[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)**：可以把数据库恢复到过去 30 天内的任意时刻，不需要事先做任何准备。

```bash
cd apps/worker
npx wrangler d1 time-travel info nana-db -c wrangler.deploy.json        # 查看可恢复的时间点
npx wrangler d1 time-travel restore nana-db --timestamp=<时间> -c wrangler.deploy.json
```

（`wrangler.deploy.json` 是运行 `pnpm run setup` 时生成的。）

想再留一份离线副本，可以导出成 SQL 文件。数据库里有全文搜索用的虚拟表，`wrangler d1 export` 不能整库导出，要用 `--table` 列出普通的表：

```bash
cd apps/worker
npx wrangler d1 export nana-db --remote -c wrangler.deploy.json --output nana-db.sql \
  --table assets --table asset_files --table folders --table albums --table album_assets \
  --table people --table faces --table face_scans --table face_rejects \
  --table smart_sets --table smart_set_examples --table duplicate_ignores
```

原文件名在 `asset_files.original_name`，对应 R2 里的 `r2_key`。

## 迁移到另一个 Cloudflare 账号

最简单、最可靠的办法：在新账号上按[部署](../../deploy/prepare/)完整部署一次，然后按文件夹把照片下载下来、再上传到新的相册（或者用设备界面上传整个目录）。照片、拍摄时间、位置都会重新从原件里读出来，人物和相似照片会重新识别。会丢失的是：相册、收藏、手动修改过的元数据、编辑、人物的名字。

完整迁移（连同相册、人物、编辑）需要把 R2 桶和 D1 数据一起搬过去，涉及直接操作数据库，目前没有现成的工具。有需要的话欢迎在 [issue](https://github.com/darmau/nana-storage/issues) 里说明。

## 离开那时

照片原件从来没有被修改过：上面的 zip 下载或 R2 同步拿到的就是你上传时的原文件，可以直接导入任何别的相册软件。编辑（裁切、打码）只存在于那时自己的缩略图和预览里。
