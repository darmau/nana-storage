#!/usr/bin/env python3
"""
nana 图片描述批处理：在主人自己的电脑上本地跑，不依赖 Docker、不改任何服务端代码。

流程（和 apps/device 相同的身份与协议，只用到现有接口）：
  1. cloudflared access token 取 JWT，放在 cf-access-token 头里（唯一被允许的身份，见 apps/device/client.mjs）。
  2. 枚举照片：默认全库（时间线按月，连拍展开成每一张 + 归档页）；`--folder` 只枚举指定文件夹及其所有子文件夹。
  3. 对每张“描述为空”的照片：下载预览 → 缩到 --max-edge → 交给本地 Ollama(qwen2.5vl) 生成一句中文描述
     → PATCH /api/assets/:id 写回 description。
  4. 进度存在本地 SQLite，随时中断，下次接着跑。

写回 description 的取舍（按用户选择“复用 description，零服务端改动”）：
  - 只写“描述为空”的照片，绝不覆盖手写描述。
  - PATCH 会顺带置上 meta_locked 的描述位（第 4 位）：语义上等于“描述已锁定”，重处理不会覆盖它。
    对单用户相册无害，只是以后无法从字段上区分“手写”和“AI 生成”。
  - 视频默认跳过（预览只是一帧，意义不大），--include-videos 才处理。

依赖：ollama、httpx、Pillow（见 requirements.txt）；cloudflared 已在 PATH 且登录过。
"""

import argparse
import base64
import io
import json
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import httpx
import ollama
from PIL import Image

def prompt_for(path: str, extra: str = None) -> str:
    """按照片所在文件夹生成提示词：文件夹名通常指示照片中的人物/主题，让描述带上这个信息。
    extra 是用户额外追加的要求（如“这个文件夹所有图片的主角都是娜娜”），作为必须遵守的补充约束写进提示词。"""
    ctx = (
        f"这张照片位于相册文件夹「{path}」。文件夹名通常指示照片中的人物或主题，"
        "请结合它生成描述（人名可当作照片中的人物，例如文件夹名里的名字）。"
        if path
        else ""
    )
    extra_ctx = (f"另外，请务必遵守这条补充要求：{extra}。" if extra else "")
    return (
        "你是相册的照片标注助手。" + ctx + extra_ctx +
        "用一句中文，客观、准确地描述这张照片的内容：尽量包含主要人物、主要物体、场景或地点、动作、画面里明显的文字。"
        "不要评价画质，不要输出描述以外的任何内容，不要用“这是一张……的照片”之类的开头。"
    )

JWT_RE = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")
RETRY_STATUS = {429, 500, 502, 503, 504}
RETRIES = 5


class AuthError(Exception):
    pass


class ApiError(Exception):
    def __init__(self, status, body):
        super().__init__(f"{status} {body[:200]}")
        self.status = status


def jwt_exp(token: str) -> float:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return float(json.loads(base64.urlsafe_b64decode(payload))["exp"])
    except Exception:
        return 0.0


class Nana:
    """和 Worker 通信。身份是主人自己的 Access 登录，和设备端 client.mjs 完全一致。"""

    def __init__(self, site: str, cloudflared: str = "cloudflared"):
        self.site = site.rstrip("/")
        self.cloudflared = cloudflared
        self.token = None
        self.client = httpx.Client(
            timeout=httpx.Timeout(connect=20, read=120, write=60, pool=20),
            follow_redirects=False,
        )

    def close(self):
        self.client.close()

    def _cloudflared_token(self) -> str:
        try:
            p = subprocess.run(
                [self.cloudflared, "access", "token", f"-app={self.site}"],
                capture_output=True, text=True, timeout=30,
            )
        except FileNotFoundError:
            raise AuthError("找不到 cloudflared 命令：先安装 cloudflared 并 cloudflared access login")
        if p.returncode != 0:
            raise AuthError(
                f"cloudflared 取令牌失败：{p.stderr.strip()[:300]}\n先运行 cloudflared access login {self.site}"
            )
        for tok in p.stdout.split():
            if JWT_RE.fullmatch(tok):
                return tok
        raise AuthError("cloudflared 输出里没有 JWT")

    def get_token(self) -> str:
        if self.token and jwt_exp(self.token) - 60 > time.time():
            return self.token
        self.token = self._cloudflared_token()
        return self.token

    def request(self, method: str, path: str, body=None, raw: bool = False):
        """请求 /api{path}。body 是写请求的 JSON 对象；raw=True 时返回字节（下载预览）。"""
        for attempt in range(RETRIES + 1):
            headers = {"cf-access-token": self.get_token()}
            if method != "GET":
                headers["x-requested-with"] = "nana"
                headers["origin"] = self.site
            payload = None
            if body is not None:
                headers["content-type"] = "application/json"
                payload = json.dumps(body).encode()
            try:
                r = self.client.request(method, self.site + path, headers=headers, content=payload)
            except httpx.HTTPError as e:
                if attempt < RETRIES:
                    time.sleep(2 ** attempt)
                    continue
                raise ApiError(0, str(e))

            # Access 拦下来时是重定向到登录页，或 401/403
            if r.status_code in (301, 302, 303, 307, 308):
                self.token = None
                raise AuthError("被重定向到登录页，请重新 cloudflared access login")
            if r.status_code in (401, 403):
                self.token = None
                if attempt == 0:  # 刷新令牌重试一次
                    time.sleep(1)
                    continue
                raise AuthError("401/403 鉴权失败，请重新登录")
            if r.status_code in RETRY_STATUS and attempt < RETRIES:
                time.sleep(2 ** attempt)
                continue
            if r.status_code >= 400:
                raise ApiError(r.status_code, r.text[:300])

            ct = r.headers.get("content-type", "")
            if raw:
                return r.content
            return r.json() if "json" in ct else r.text


def enumerate_ids(nana: Nana):
    """生成器：逐个产出所有可见照片 (id, kind_hint)。kind_hint：0 photo/1 video/2 live，None 未知（连拍成员）。
    边枚举边打印进度，不会让“枚举”阶段看起来像卡死。"""
    buckets = nana.request("GET", "/api/timeline/buckets")
    n_months = len(buckets)
    for i, b in enumerate(buckets, 1):
        print(f"  枚举时间线 {i}/{n_months} 月（{b['month']}，{b['count']} 张）", file=sys.stderr)
        items = nana.request("GET", f"/api/timeline/month/{b['month']}")
        for it in items:
            burst = it[8] if len(it) > 8 and it[8] else None
            if burst:
                for bid in burst:  # 连拍里每一张都是独立照片，各生成一句
                    yield (bid, None)
            else:
                yield (it[0], it[3])
    # 归档照片（也在搜索里，一并覆盖）
    offset = 0
    page_no = 0
    while True:
        data = nana.request("GET", f"/api/archive/assets?offset={offset}")
        page_no += 1
        print(f"  枚举归档第 {page_no} 页", file=sys.stderr)
        for it in data["items"]:
            yield (it[0], it[3])
        if data["next"] is None:
            break
        offset = data["next"]


def resolve_folder(nana: Nana, path: str):
    """把从根开始的路径（'a/b/c'，或 'root'）解析成文件夹 id；根目录返回 None。找不到抛 ValueError。"""
    if not path or path == "root":
        return None
    segs = [s for s in path.split("/") if s]
    cur = None
    for i, seg in enumerate(segs):
        data = nana.request("GET", f"/api/folders/{cur or 'root'}")
        child = next((c for c in data["children"] if c["name"] == seg), None)
        if child is None:
            here = "/".join(segs[:i]) or "根目录"
            raise ValueError(f"找不到文件夹「{path}」：在「{here}」下没有「{seg}」")
        cur = child["id"]
    return cur


def enumerate_folder(nana: Nana, folder_id):
    """生成器：产出某个文件夹（含所有子文件夹）里的全部照片 (id, kind)。
    走 /folders/:id/assets 分页 + /folders/:id 递归子文件夹；?archived=1 把归档的照片也一并带上。"""
    base = folder_id or "root"
    info = nana.request("GET", f"/api/folders/{base}")
    offset = 0
    while True:
        data = nana.request("GET", f"/api/folders/{base}/assets?offset={offset}&archived=1")
        for it in data["items"]:
            yield (it[0], it[3])
        if data["next"] is None:
            break
        offset = data["next"]
    for c in info["children"]:
        yield from enumerate_folder(nana, c["id"])


def list_folders(nana: Nana):
    """打印完整文件夹树（路径 + id），用来确定 --folder 的路径。"""
    def walk(folder_id, prefix):
        base = folder_id or "root"
        data = nana.request("GET", f"/api/folders/{base}")
        for c in data["children"]:
            p = f"{prefix}/{c['name']}" if prefix else c["name"]
            print(f"{p}\t{c['id']}")
            walk(c["id"], p)
    walk(None, "")


def caption_one(nana: Nana, model: str, asset_id: str, rev: int, max_edge: int, path: str = "", extra: str = None) -> str:
    raw = nana.request("GET", f"/api/a/{asset_id}/preview?v={rev}", raw=True)
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    img.thumbnail((max_edge, max_edge))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    resp = ollama.chat(model=model, messages=[{"role": "user", "content": prompt_for(path, extra), "images": [buf.getvalue()]}])
    text = (resp.get("message") or {}).get("content", "").strip()
    if not text:
        raise RuntimeError("模型返回空描述")
    return text


def clear_captions(nana: Nana, db):
    """清空本机进度库里 AI 写过的描述（status='captioned'），手写的不动。
    只清“当前描述仍是 AI 写的那句”的：期间被用户改过的保留，只移除 AI 标记。"""
    rows = db.execute("SELECT asset_id, caption FROM done WHERE status = 'captioned'").fetchall()
    if not rows:
        print("没有 AI 写过的描述需要清空。", file=sys.stderr)
        return
    print(f"将清空 {len(rows)} 条 AI 描述（手写的不动）...", file=sys.stderr)
    cleared = skipped = failed = 0
    for i, (aid, caption) in enumerate(rows, 1):
        try:
            asset = nana.request("GET", f"/api/assets/{aid}")
            cur = (asset.get("description") or "").strip()
            if not cur:
                db.execute("DELETE FROM done WHERE asset_id = ?", (aid,))
            elif " ".join(cur.split()) == " ".join((caption or "").split()):
                nana.request("PATCH", f"/api/assets/{aid}", body={"description": None})
                db.execute("DELETE FROM done WHERE asset_id = ?", (aid,))
                cleared += 1
            else:
                # 期间被用户改过，保留描述，只移除 AI 标记（下次跑会当“已有描述”跳过）
                db.execute("DELETE FROM done WHERE asset_id = ?", (aid,))
                skipped += 1
        except (AuthError,) as e:
            print(f"中止：{e}", file=sys.stderr)
            db.commit(); nana.close()
            sys.exit(2)
        except Exception as e:
            failed += 1
            print(f"失败 {aid}: {str(e)[:200]}", file=sys.stderr)
        if i % 50 == 0 or i == len(rows):
            db.commit()
            print(f"[{i}/{len(rows)}] 已清空 {cleared}，保留(改过) {skipped}，失败 {failed}", file=sys.stderr)
    db.commit()
    print(f"完成：清空 {cleared} 条，保留 {skipped} 条（已被改过），失败 {failed} 条。", file=sys.stderr)


def clear_has_description(nana: Nana, db):
    """清空进度库里 status='has_description' 的照片描述（用户已确认），并移除记录以便重跑。"""
    rows = db.execute("SELECT asset_id FROM done WHERE status = 'has_description'").fetchall()
    if not rows:
        print("没有 has_description 记录需要清空。", file=sys.stderr)
        return
    print(f"将清空 {len(rows)} 条已有描述...", file=sys.stderr)
    cleared = failed = 0
    for i, (aid,) in enumerate(rows, 1):
        try:
            nana.request("PATCH", f"/api/assets/{aid}", body={"description": None})
            db.execute("DELETE FROM done WHERE asset_id = ?", (aid,))
            cleared += 1
        except (AuthError,) as e:
            print(f"中止：{e}", file=sys.stderr)
            db.commit(); nana.close()
            sys.exit(2)
        except Exception as e:
            failed += 1
            print(f"失败 {aid}: {str(e)[:200]}", file=sys.stderr)
        if i % 50 == 0 or i == len(rows):
            db.commit()
            print(f"[{i}/{len(rows)}] 已清空 {cleared}，失败 {failed}", file=sys.stderr)
    db.commit()
    print(f"完成：清空 {cleared} 条，失败 {failed} 条。", file=sys.stderr)


# --prompt 里带有“把某人/某物固定成主角”意味的措辞，配合全库（没指定 --folder）跑会误伤。
SUBJECT_HINT = ("主角", "主人公", "主人翁", "人物", "都是", "全是")


def prompt_pins_subject(prompt: str) -> bool:
    return any(k in prompt for k in SUBJECT_HINT)


def confirm(prompt_text: str) -> bool:
    """问一句 y/N；非交互（EOF）时当作取消。"""
    try:
        while True:
            ans = input(prompt_text + " [y/N] ").strip().lower()
            if ans in ("y", "yes"):
                return True
            if ans in ("", "n", "no"):
                return False
    except EOFError:
        return False


def main():
    ap = argparse.ArgumentParser(description="nana 本地图片描述批处理")
    ap.add_argument("--site", default=None, help="站点 origin，如 https://xxx.example.com（默认读 NANA_SITE）")
    ap.add_argument("--model", default="qwen2.5vl:7b", help="Ollama 模型名")
    ap.add_argument("--db", default="caption-progress.sqlite", help="进度库路径")
    ap.add_argument("--max-edge", type=int, default=1024, help="发给模型前缩到的长边")
    ap.add_argument("--limit", type=int, default=0, help="最多处理几张（0=全部），先跑几十张试试")
    ap.add_argument("--include-videos", action="store_true", help="也处理视频（默认跳过）")
    ap.add_argument("--no-pull", action="store_true", help="模型缺失时不自动 ollama pull")
    ap.add_argument("--dry-run", action="store_true", help="只枚举并打印待处理数量，不生成、不写回")
    ap.add_argument("--log", default="caption-results.jsonl", help="结果文件路径（每行一个 JSON：id/文件名/描述）")
    ap.add_argument("--no-log", action="store_true", help="不写结果文件，只在控制台打印")
    ap.add_argument("--cloudflared", default="cloudflared", help="cloudflared 可执行文件路径（默认从 PATH 找）")
    ap.add_argument("--folder", default=None, help="只处理这个文件夹及其所有子文件夹（从根开始的路径，如 小学同学/张三；root 表示根目录）")
    ap.add_argument("--list-folders", action="store_true", help="打印完整文件夹树（路径 + id）后退出")
    ap.add_argument("--prompt", default=None, help="额外追加到每条提示词里的要求，例如“这个文件夹所有图片的主角都是娜娜”")
    ap.add_argument("--clear-captions", action="store_true", help="清空本机进度库里 AI 写过的描述（只清 status=captioned 的），以便换提示词后重做")
    ap.add_argument("--clear-has-description", action="store_true", help="清空进度库里 status='has_description' 的照片描述（用户确认过的那批）")
    ap.add_argument("--sync", action="store_true", help="一次性把 D1 里现有描述同步进 AI Search 语义索引（只 upload 已有文本，不生成）")
    args = ap.parse_args()

    site = args.site or None
    if not site:
        ap.error("需要 --site（或设置 NANA_SITE）")
    # 本地开发走 http://localhost，不需要令牌（和设备端 DEV_HOSTS 一致）
    dev = site.startswith("http://")

    # --prompt 带“人物/主角”约束却没指定 --folder 时，这句话会作用于全库所有照片，先确认。
    if (
        not args.dry_run and not args.clear_captions and not args.clear_has_description
        and not args.sync and not args.list_folders
        and args.prompt and not args.folder and prompt_pins_subject(args.prompt)
    ):
        print(
            f"警告：--prompt 里的约束「{args.prompt}」看起来是在固定人物/主角，但没有指定 --folder，"
            "它会作用于全库所有照片，可能把不相关的人/物也描述错。",
            file=sys.stderr,
        )
        if not confirm("确认要对全库跑这条约束吗？"):
            print("已取消。", file=sys.stderr)
            sys.exit(2)

    # 确认模型已拉取
    if not args.no_pull and not args.dry_run and not args.clear_captions and not args.clear_has_description and not args.sync and not args.list_folders:
        have = {m.get("name") or m.get("model") for m in ollama.list().get("models", [])}
        if args.model not in have:
            print(f"拉取模型 {args.model} ...", file=sys.stderr)
            for _ in ollama.pull(args.model, stream=True):
                pass
            print("模型就绪。", file=sys.stderr)

    # cloudflared：PATH 里没有时回退到 ~/bin/cloudflared（我们免 sudo 装的位置）
    cf = args.cloudflared
    if cf == "cloudflared" and shutil.which("cloudflared") is None:
        home_cf = Path.home() / "bin" / "cloudflared"
        if home_cf.exists():
            cf = str(home_cf)

    nana = Nana(site, cloudflared=cf)
    if dev:
        nana.get_token = lambda: ""  # 本地开发不需要令牌

    if args.list_folders:
        list_folders(nana)
        nana.close()
        return

    if args.sync:
        try:
            res = nana.request("POST", "/api/search/semantic/sync")
            print(f"已同步 {res.get('indexed', 0)} 条现有描述到语义索引。", file=sys.stderr)
        except ApiError as e:
            print(f"同步失败：{e}", file=sys.stderr)
            nana.close()
            sys.exit(2)
        nana.close()
        return

    db = sqlite3.connect(args.db)
    db.execute("CREATE TABLE IF NOT EXISTS done (asset_id TEXT PRIMARY KEY, status TEXT NOT NULL, caption TEXT, ts INTEGER NOT NULL)")
    db.commit()
    is_done = lambda aid: db.execute("SELECT 1 FROM done WHERE asset_id = ?", (aid,)).fetchone() is not None
    mark = lambda aid, status, caption=None: db.execute(
        "INSERT OR REPLACE INTO done (asset_id, status, caption, ts) VALUES (?, ?, ?, ?)",
        (aid, status, caption, int(time.time() * 1000)),
    )

    if args.clear_captions:
        clear_captions(nana, db)
        nana.close(); db.close()
        return
    if args.clear_has_description:
        clear_has_description(nana, db)
        nana.close(); db.close()
        return

    log = None
    if not args.no_log and not args.dry_run:
        log = open(args.log, "a", encoding="utf-8")
        print(f"结果写入 {args.log}", file=sys.stderr)

    print("开始枚举并处理照片（边枚举边生成，读到第一个月就开始）...", file=sys.stderr)

    if args.folder is None:
        src = enumerate_ids(nana)
    else:
        try:
            fid = resolve_folder(nana, args.folder)
        except ValueError as e:
            print(f"错误：{e}", file=sys.stderr)
            if log:
                log.close()
            db.close()
            nana.close()
            sys.exit(2)
        print(f"只处理文件夹「{args.folder}」及其所有子文件夹", file=sys.stderr)
        src = enumerate_folder(nana, fid)

    if args.dry_run:
        pending = 0
        for aid, kind in src:
            if kind == 1 and not args.include_videos:
                continue
            if is_done(aid):
                continue
            pending += 1
        print(f"待处理 {pending} 张。", file=sys.stderr)
        nana.close(); db.close()
        return

    done = skipped_has_desc = skipped_video = failed = 0
    t0 = time.time()
    for aid, kind in src:
        if kind == 1 and not args.include_videos:
            skipped_video += 1
            continue
        if is_done(aid):
            continue
        try:
            asset = nana.request("GET", f"/api/assets/{aid}")
            if asset.get("kind") == "video" and not args.include_videos:
                mark(aid, "video"); skipped_video += 1; continue
            if (asset.get("description") or "").strip():
                mark(aid, "has_description"); skipped_has_desc += 1; continue
            rev = int(asset.get("derived_rev") or 0)
            path = " / ".join(f.get("name") for f in (asset.get("folder_path") or []) if f.get("name"))
            text = caption_one(nana, args.model, aid, rev, args.max_edge, path, args.prompt)
            nana.request("PATCH", f"/api/assets/{aid}", body={"description": text})
            mark(aid, "captioned", text)
            done += 1
            # 每张改完立刻可见：控制台一行“文件名 + 描述”，结果文件一行 JSON。
            name = asset.get("file_name") or aid
            line = " ".join(text.split())  # 折成一行，方便看/查
            print(f"{name}\t{line}", flush=True)
            if log:
                log.write(json.dumps({"id": aid, "file": name, "caption": text}, ensure_ascii=False) + "\n")
                if done % 20 == 0:
                    log.flush()
        except (AuthError,) as e:
            print(f"中止：{e}", file=sys.stderr)
            if log:
                log.flush(); log.close()
            db.commit(); nana.close(); db.close()
            sys.exit(2)
        except Exception as e:
            failed += 1
            print(f"失败 {aid}: {str(e)[:300]}", file=sys.stderr)

        if done % 10 == 0 and done > 0:
            el = time.time() - t0
            rate = done / el if el > 0 else 0
            print(
                f"[已写回 {done} 张，跳过已有描述 {skipped_has_desc}，跳过视频 {skipped_video}，"
                f"失败 {failed}，速度 {rate:.2f} 张/秒]",
                file=sys.stderr,
            )
        if done % 50 == 0:
            db.commit()
        if args.limit and done >= args.limit:
            break

    db.commit()
    if log:
        log.flush(); log.close()
    print(
        f"完成。写回 {done} 张，跳过已有描述 {skipped_has_desc} 张，跳过视频 {skipped_video} 张，失败 {failed} 张。"
        f"总耗时 {time.time() - t0:.0f} 秒。",
        file=sys.stderr,
    )
    nana.close(); db.close()


if __name__ == "__main__":
    main()
