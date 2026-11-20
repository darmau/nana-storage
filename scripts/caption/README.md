# nana 图片描述批处理

在主人自己的电脑上本地跑一个视觉模型（Ollama + qwen2.5vl），给相册里的照片生成一句中文描述，写回 `description` 字段，让搜索（文件名 + 描述全文索引）能按内容搜到照片。

**零服务端改动**：只用现有的接口，身份和设备端处理（`apps/device`）完全一样（`cloudflared` Access 登录）。

## 工作原理

1. `cloudflared access token` 取 JWT，放在 `cf-access-token` 头里（唯一被允许的身份，见 `apps/device/client.mjs`）。
2. 枚举照片：
   - 默认全库：时间线按月（连拍展开成每一张）+ 归档页。
   - `--folder`：只枚举指定文件夹及其所有子文件夹（嵌套递归）。
3. 对每张「描述为空」的照片：下载预览 → 缩到 `--max-edge` → 交给本地 Ollama 生成一句中文描述 → `PATCH /api/assets/:id` 写回 `description`。
4. 进度存在本地 SQLite，随时中断，下次接着跑。

## 依赖（本机，非 Docker）

1. **Ollama**（原生 macOS，自动用 Metal GPU）：<https://ollama.com/download>
   ```bash
   ollama pull qwen2.5vl:7b        # 约 6 GB，16GB+ 内存的 Mac 较顺；要快用 qwen2.5vl:3b
   ```
2. **cloudflared** 并登录过站点（和设备端同一个身份，唯一被允许的方式）。

   安装（macOS，二选一）：
   - Homebrew：`brew install cloudflared`
   - 或免 sudo 下载到 `~/bin/cloudflared`（脚本会自动回退到它，见 `--cloudflared`）：
     ```bash
     mkdir -p ~/bin
     # Apple Silicon 用 arm64，Intel 用 amd64
     curl -L "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64" -o ~/bin/cloudflared
     chmod +x ~/bin/cloudflared
     ```

   登录（把 Access 会话存进 `~/.cloudflared`）：
   ```bash
   cloudflared access login https://<你的站点>
   ```
   > `~/bin` 通常不在 PATH 里，如果提示 `command not found: cloudflared`，用全路径 `~/bin/cloudflared access login https://<你的站点>`；或者把 `~/bin` 加进 PATH：`echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc`。
   >
   > 跑 `caption.py` 不需要上面这一步：脚本在 PATH 里找不到 `cloudflared` 时会自动回退到 `~/bin/cloudflared`（见 `--cloudflared`）。
3. Python 依赖：
   ```bash
   cd scripts/caption
   python3 -m venv .venv && source .venv/bin/activate
   pip install -r requirements.txt
   ```
   （`requirements.txt`：`ollama>=0.4`、`httpx>=0.27`、`Pillow>=10.0`）

## 快速开始

先小批量试跑 20 张，确认描述质量：

```bash
python caption.py --site https://<你的站点> --limit 20
```

会先拉模型（如缺失）、枚举照片、处理 20 张。确认没问题后，放开跑全库：

```bash
python caption.py --site https://<你的站点>
```

只处理某个文件夹（含嵌套子文件夹）时，先列一下树、确认路径，再小批量试：

```bash
python caption.py --site https://<你的站点> --list-folders
python caption.py --site https://<你的站点> --folder rose --limit 20
```

配合 `--prompt` 追加约束，让同一个人/主题更稳定：

```bash
python caption.py --site https://<你的站点> --folder rose --prompt "这个文件夹所有图片的主角都是娜娜"
```

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--site` | 必填 | 站点 origin，如 `https://xxx.example.com` |
| `--model` | `qwen2.5vl:7b` | Ollama 模型名 |
| `--max-edge` | `1024` | 发给模型前缩到的长边 |
| `--include-videos` | 关 | 也处理视频（默认跳过，视频预览只是一帧） |
| `--folder` | 无（全库） | 只处理这个文件夹及其所有子文件夹（从根开始的路径，如 `小学同学/张三`；`root` 表示根目录），嵌套会递归 |
| `--list-folders` | 关 | 打印完整文件夹树（路径 + id）后退出 |
| `--prompt` | 无 | 额外追加到每条提示词里的要求，例如“这个文件夹所有图片的主角都是娜娜” |
| `--limit` | `0`（全部） | 最多处理几张 |
| `--db` | `caption-progress.sqlite` | 进度库路径（可改名，多台/多轮互不影响） |
| `--log` | `caption-results.jsonl` | 结果文件路径（每行一个 JSON：id / 文件名 / 描述） |
| `--no-log` | 关 | 不写结果文件，只在控制台打印 |
| `--dry-run` | 关 | 只枚举并打印待处理数量，不生成、不写回 |
| `--no-pull` | 关 | 模型缺失时不自动 `ollama pull` |
| `--cloudflared` | `cloudflared` | cloudflared 可执行文件路径（默认从 PATH 找；PATH 里没有时自动回退到 `~/bin/cloudflared`） |
| `--clear-captions` | 关 | 清空本机进度库里 AI 写过的描述（只清 `status=captioned` 的） |
| `--clear-has-description` | 关 | 清空进度库里 `status=has_description` 的照片描述并移除记录，便于重跑 |
| `--sync` | 关 | 一次性把 D1 里现有描述同步进 AI Search 语义索引（只 upload 已有文本，不生成） |

## 指定文件夹（`--folder`）

- **路径从根开始**，用 `/` 分隔各级，例如 `--folder rose`、`--folder 小学同学/张三`；`root` 表示根目录（等同于全库）。
- 文件夹名本身不允许含 `/`（服务端 `cleanFolderName` 校验过），所以用 `/` 当分隔符不会有歧义。
- **嵌套会递归**：指定某个文件夹时，它和它下面所有子文件夹的照片都会处理。
- **同名文件夹要写全路径**：如果有两个不同父级下各有一个「张三」，只写 `张三` 会从根开始找、找不到就报错，必须写 `小学同学/张三` 之类完整路径区分。
- **归档照片也处理**：`--folder` 枚举时带 `?archived=1`，所以该文件夹（含子文件夹）里归档的照片也会一起生成描述；不加 `--folder` 时归档照片走归档页，同样覆盖。
- `--list-folders` 打印完整文件夹树（路径 + id）后退出，用来确认路径，不会触发拉模型。

## `--prompt` 与保护

- `--prompt` 会把你的话作为「必须遵守的补充要求」追加进每条提示词，例如 `"这个文件夹所有图片的主角都是娜娜"`，模型就会把「娜娜」当作主角来写，而不是自己认成别人。
- `--prompt` 作用于**本次运行的所有照片**，所以它天然应该和 `--folder` 搭配（一次只跑一个主角/主题）。
- 保护：当 `--prompt` 里包含「主角 / 主人公 / 主人翁 / 人物 / 都是 / 全是」任一关键词、又没有同时给 `--folder` 时，脚本会在拉模型之前停下来，问「确认要对全库跑这条约束吗？」（`y/N`）；不确认就退出，避免一句话带偏整库。`--dry-run`、`--clear-*`、`--sync`、`--list-folders` 不会触发这个确认。

## 结果怎么看

每张照片改完会**立刻**输出，两处都有：

1. **控制台**：一行「文件名 + 描述」，例如 `IMG_1234.jpg	一只金毛犬在草地上奔跑`。
2. **结果文件** `caption-results.jsonl`（可用 `--log` 改名）：每行一个 JSON `{"id": "...", "file": "IMG_1234.jpg", "caption": "..."}`，随时 `grep` 或翻看。

改过的描述同时也会出现在 nana 网页版的信息面板里（描述字段），并且立刻能被搜索命中。进度/计数打印在 stderr，所以想把纯结果重定向到文件也不影响：`python caption.py ... 2>/dev/null > results.txt`。

## 它会做什么 / 不会做什么

- **枚举**：默认全库——时间线按月（连拍里每一张都展开）+ 归档页，覆盖所有 `ready`、未删除的照片（含归档）。加 `--folder` 则只覆盖该文件夹整棵子树。
- **只写空描述**：每张先 `GET /api/assets/:id` 看 `description`，非空就跳过，绝不覆盖手写描述。
- **断点续跑**：进度存在本地 SQLite（`--db`），随时 Ctrl-C / 关机，下次重跑自动接着剩下的。
- **单张失败不中断**：失败的那张记日志跳过，下次重跑再试。

## 清理 / 重做

- **`--clear-captions`**：清空本机进度库里 AI 写过的描述（`status=captioned`），用来换提示词后重做。它只清「当前描述仍等于 AI 写的那句」的：期间被你改过的会保留你的描述，只移除 AI 标记（下次跑会当“已有描述”跳过）。
- **`--clear-has-description`**：清空进度库里 `status=has_description` 的照片描述（这些是运行前就已经有非空描述、被跳过的），并移除记录，让它们重新进入候选。⚠️ 注意：这会把运行前就存在的描述（可能是手写的）也清空，用之前先确认。
- **换更好的模型推倒重来**：把 `--db` 换一个名字即可；但已经写进 `description` 的描述不会自动清空——需要先 `--clear-captions`（或手动清），否则只会补剩下空白的。

## 同步到语义搜索（`--sync`）

描述写进 D1 后，会被同步到 Cloudflare AI Search 语义索引（尽力而为）。`--sync` 一次性把 D1 里现有的描述搬运进语义索引（只 upload 已有文本，不生成），漏掉的靠它补：

```bash
python caption.py --site https://<你的站点> --sync
```

## 已知取舍（“复用 description”带来的）

- AI 描述和手写描述在同一个 `description` 字段里，无法从数据上区分。
- 写回会顺带置上 `meta_locked` 的描述位（第 4 位）：以后重新处理不会覆盖它；语义上等于“描述被锁定”，对单用户无害。

## 成本 / 时间（估算）

- 费用 ≈ 0：模型本地跑，R2 出口流量免费，云端只有读写请求，落在免费额度内。
- 耗时（Metal GPU，`qwen2.5vl:7b`）：约 4 秒/张 → 38 万张连续约 17 天；手动每天跑几小时则几周~两个月，可随时中断。
- 带宽：预览约 0.5–1 MB/张，全程约 200–400 GB 下载，家宽一次性可接受。
