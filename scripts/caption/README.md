# nana 本地图片描述批处理

在主人自己的电脑上本地跑一个视觉模型，给相册里的照片生成一句中文描述，写回 `description` 字段，让搜索（文件名 + 描述全文索引）能按内容搜到照片。

**零服务端改动**：只用现有的接口，身份和设备端处理（`apps/device`）完全一样。

## 依赖（本机，非 Docker）

1. **Ollama**（原生 macOS，自动用 Metal GPU）：<https://ollama.com/download>
   ```bash
   ollama pull qwen2.5vl:7b        # 约 6 GB，16GB+ 内存的 Mac 较顺；要快用 qwen2.5vl:3b
   ```
2. **cloudflared** 并登录过站点（和设备端同一个身份，唯一被允许的方式）：
   ```bash
   cloudflared access login https://<你的站点>
   ```
3. Python 依赖：
   ```bash
   cd scripts/caption
   python3 -m venv .venv && source .venv/bin/activate
   pip install -r requirements.txt
   ```

## 先小批量试跑

```bash
python caption.py --site https://<你的站点> --limit 20
```

会先拉模型（如缺失）、枚举照片、处理 20 张。确认描述质量后，再放开跑全量：

```bash
python caption.py --site https://<你的站点>
```

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--site` | `NANA_SITE` 环境变量 | 站点 origin |
| `--model` | `qwen2.5vl:7b` | Ollama 模型名 |
| `--db` | `caption-progress.sqlite` | 进度库（可改名，多台/多轮互不影响） |
| `--max-edge` | `1024` | 发给模型前缩到的长边 |
| `--limit` | `0`（全部） | 最多处理几张 |
| `--include-videos` | 关 | 也处理视频（默认跳过，视频预览只是一帧） |
| `--no-pull` | 关 | 模型缺失时不自动 pull |
| `--dry-run` | 关 | 只枚举并打印待处理数量，不生成不写回 |
| `--log` | `caption-results.jsonl` | 结果文件路径（每行一个 JSON：id / 文件名 / 描述） |
| `--no-log` | 关 | 不写结果文件，只在控制台打印 |

## 结果怎么看

每张照片改完会**立刻**输出，两处都有：

1. **控制台**：一行「文件名 + 描述」，例如 `IMG_1234.jpg	一只金毛犬在草地上奔跑`。
2. **结果文件** `caption-results.jsonl`（可用 `--log` 改名）：每行一个 JSON `{"id": "...", "file": "IMG_1234.jpg", "caption": "..."}`，随时 `grep` 或翻看。

改过的描述同时也会出现在 nana 网页版的信息面板里（描述字段），并且立刻能被搜索命中。进度/计数打印在 stderr，所以想把纯结果重定向到文件也不影响：`python caption.py ... 2>/dev/null > results.txt`。

## 它会做什么 / 不会做什么

- **枚举**：时间线按月（连拍里每一张都展开）+ 归档页。覆盖所有 `ready`、未删除的照片（含归档，归档照片也在搜索里）。
- **只写空描述**：每张先 `GET /api/assets/:id` 看 `description`，非空就跳过，绝不覆盖手写描述。
- **断点续跑**：进度存在本地 SQLite，随时 Ctrl-C / 关机，下次重跑自动接着剩下的。
- **单张失败不中断**：失败的那张记日志跳过，下次重跑再试。

## 已知取舍（“复用 description”带来的）

- AI 描述和手写描述在同一个 `description` 字段里，无法从数据上区分。
- 写回会顺带置上 `meta_locked` 的描述位（第 4 位）：以后重新处理不会覆盖它；语义上等于“描述被锁定”，对单用户无害。
- 想彻底推倒重来（换更好的模型）：把 `--db` 换一个名字即可，但已经写进 `description` 的描述不会自动清空——需要先手动清（或接受只补剩下空白的）。

## 成本 / 时间（估算）

- 费用 ≈ 0：模型本地跑，R2 出口流量免费，云端只有读写请求，落在免费额度内。
- 耗时（Metal GPU，`qwen2.5vl:7b`）：约 4 秒/张 → 38 万张连续约 17 天；手动每天跑几小时则几周~两个月，可随时中断。
- 带宽：预览约 0.5–1 MB/张，全程约 200–400 GB 下载，家宽一次性可接受。
