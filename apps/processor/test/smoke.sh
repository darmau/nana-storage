#!/bin/sh
# 容器冒烟测试：在 apps/processor 下运行 sh test/smoke.sh
set -e
OUT=${TMPDIR:-/tmp}/nana-proc-smoke; mkdir -p "$OUT"
docker rm -f nana-proc-test >/dev/null 2>&1 || true
docker run -d --rm --platform linux/amd64 -p 18080:8080 --name nana-proc-test nana-processor:dev >/dev/null
trap 'docker rm -f nana-proc-test >/dev/null 2>&1' EXIT
for i in $(seq 1 50); do curl -sf localhost:18080/health >/dev/null && break; sleep 0.2; done

summ() { python3 -c '
import json,sys,base64
d=json.load(open(sys.argv[1])); m=d["meta"]
keys=["MIMEType","DateTimeOriginal","OffsetTimeOriginal","CreationDate","CreateDate","GPSLatitude","GPSLongitude","Model","Orientation","Duration","ContentIdentifier"]
print("  sha", d["sha256"][:12], "size", d["size"], {k:m[k] for k in keys if k in m})
if "thumb" in d:
    print("  derived", d["width"], "x", d["height"], "thumb", len(base64.b64decode(d["thumb"])), "B preview", len(base64.b64decode(d["preview"])), "B")
' "$1"; }

echo "meta photo.jpg";  curl -sf --data-binary @test/fixtures/photo.jpg localhost:18080/tasks/meta -o "$OUT/m.json"; summ "$OUT/m.json"
echo "  (host sha $(shasum -a 256 test/fixtures/photo.jpg | cut -c1-12))"
for spec in photo.jpg:image:0 photo.jpg:image:90 photo.heic:image:0 video.mov:video:0; do
	IFS=: read f k r <<-X
	$spec
	X
	echo "derive $f kind=$k rot=$r"
	curl -sf -H "x-kind: $k" -H "x-rotation: $r" --data-binary @test/fixtures/$f localhost:18080/tasks/derive -o "$OUT/d.json" || { echo "  FAILED"; curl -s -H "x-kind: $k" --data-binary @test/fixtures/$f localhost:18080/tasks/derive | head -c 600; echo; continue; }
	summ "$OUT/d.json"
done
echo "transcode video.mov"
curl -sf -H "x-timeout-ms: 120000" --data-binary @test/fixtures/video.mov localhost:18080/tasks/transcode -o "$OUT/out.mp4" -w "  %{http_code} %{content_type} %{size_download}B\n"
docker exec nana-proc-test sh -c 'true' && docker cp "$OUT/out.mp4" nana-proc-test:/tmp/out.mp4 && docker exec nana-proc-test ffprobe -v error -show_entries stream=codec_name,width,height,pix_fmt -of csv=p=0 /tmp/out.mp4 | sed 's/^/  /'
echo "unknown task -> $(curl -s -o /dev/null -w %{http_code} -X POST localhost:18080/tasks/__proto__)"
echo "bad input   -> $(printf 'not an image' | curl -s -o /dev/null -w %{http_code} -H 'x-kind: image' --data-binary @- localhost:18080/tasks/derive)"

# 卡住的进程必须被 kill：给转码一个 1ms 的超时，应该立刻失败，而不是跑完
t0=$(python3 -c 'import time;print(time.time())')
code=$(curl -s -o "$OUT/timeout.txt" -w %{http_code} -H "x-timeout-ms: 1" --data-binary @test/fixtures/video.mov localhost:18080/tasks/transcode)
t1=$(python3 -c 'import time;print(time.time())')
echo "timeout     -> $code in $(python3 -c "print(round($t1-$t0,2))")s: $(head -c 80 "$OUT/timeout.txt")"
echo "ffmpeg left -> $(docker exec nana-proc-test sh -c 'ls /proc/*/comm 2>/dev/null | xargs cat 2>/dev/null | grep -c ffmpeg' || true)"

# 指纹：同一张图的缩小 / 重新压缩 / 换格式版本感知哈希距离很小，不同的图距离大；向量 512 维
echo "fingerprints"
docker exec nana-proc-test sh -c 'cd /tmp && ffmpeg -v error -f lavfi -i mandelbrot=size=2400x1800:end_pts=40 -vf "select=eq(n\,30)" -frames:v 1 -q:v 2 -y fa.jpg \
 && ffmpeg -v error -f lavfi -i testsrc2=size=2400x1800 -frames:v 1 -q:v 2 -y fb.jpg \
 && vips thumbnail fa.jpg fa_small.jpg 640 && vips copy fa.jpg fa_q20.jpg[Q=20] && vips copy fa.jpg fa.webp[Q=50]'
for f in fa.jpg fa_small.jpg fa_q20.jpg fa.webp fb.jpg; do
	docker cp nana-proc-test:/tmp/$f "$OUT/$f"
	curl -sf -H 'x-kind: image' --data-binary @"$OUT/$f" localhost:18080/tasks/derive -o "$OUT/$f.json" || echo "  FAILED $f"
done
curl -sf -H 'x-kind: image' -H 'x-fingerprint: skip' --data-binary @"$OUT/fa.jpg" localhost:18080/tasks/derive -o "$OUT/skip.json"
python3 - "$OUT" <<'PY'
import json, sys, base64, math
out = sys.argv[1]
def load(n):
    fp = json.load(open(f"{out}/{n}.json"))["fp"]
    q = [x - 256 if x > 127 else x for x in base64.b64decode(fp["embedding"])]
    return fp["phash"], q
def ham(a, b): return bin(int(a, 16) ^ int(b, 16)).count("1")
def cos(a, b): return sum(x * y for x, y in zip(a, b)) / math.sqrt(sum(x * x for x in a) * sum(y * y for y in b))
ref = load("fa.jpg")
ok = len(ref[1]) == 512
for n in ["fa_small.jpg", "fa_q20.jpg", "fa.webp"]:
    h, q = load(n); d = ham(h, ref[0]); ok &= d <= 4
    print(f"  {n:13} hamming {d:2} cos {cos(q, ref[1]):.3f}")
h, q = load("fb.jpg"); d = ham(h, ref[0]); ok &= d > 10
print(f"  {'fb.jpg':13} hamming {d:2} cos {cos(q, ref[1]):.3f}  (different image)")
skip = json.load(open(f"{out}/skip.json"))
ok &= skip["fp"] is None and "thumb" in skip
print("  x-fingerprint: skip ->", "no fp" if skip["fp"] is None else "fp!")
print("  fingerprints", "OK" if ok else "FAILED")
PY

# 人脸：没有人脸的照片返回空列表；FACE_IMAGE 指向一张合影时（比如 InsightFace 仓库的 t1.jpg，6 个人）检查检测结果和头像
echo "faces"
curl -sf -H 'x-kind: image' --data-binary @test/fixtures/photo.jpg localhost:18080/tasks/derive -o "$OUT/faces0.json"
python3 -c 'import json,sys; f=json.load(open(sys.argv[1]))["faces"]; print("  photo.jpg ->", f and (f["model"], len(f["faces"]), f["sprite"] is None))' "$OUT/faces0.json"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("  skip ->", "no faces" if d.get("faces") is None else "faces!")' "$OUT/skip.json"
if [ -n "$FACE_IMAGE" ]; then
	t0=$(python3 -c 'import time;print(time.time())')
	curl -sf -H 'x-kind: image' --data-binary @"$FACE_IMAGE" localhost:18080/tasks/derive -o "$OUT/faces1.json"
	t1=$(python3 -c 'import time;print(time.time())')
	python3 - "$OUT" "$(python3 -c "print(round($t1-$t0,2))")" <<'PY'
import json, sys, base64
out, secs = sys.argv[1], sys.argv[2]
d = json.load(open(f"{out}/faces1.json"))["faces"]
sprite = base64.b64decode(d["sprite"])
open(f"{out}/faces.webp", "wb").write(sprite)
print(f"  {len(d['faces'])} faces in {secs}s (whole derive), sprite {len(sprite)} B -> {out}/faces.webp")
for f in d["faces"]:
    print("   ", f["x"], f["y"], f["w"], f["h"], "score", f["score"], "sharpness", f["sharpness"], "emb", len(base64.b64decode(f["embedding"])))
PY
fi
