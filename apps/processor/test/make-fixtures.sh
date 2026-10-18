#!/bin/sh
# 在处理容器里生成测试样本（在 apps/processor 下运行）：
#   docker run --rm --platform linux/amd64 -v "$PWD/test:/test" nana-processor:dev sh /test/make-fixtures.sh
# HEIC 用 macOS 生成：sips -s format heic test/fixtures/photo.jpg --out test/fixtures/photo.heic
set -e
cd /test/fixtures
vips black base.v 4032 3024 --bands 3
vips linear base.v grad.v 1 80
vips copy grad.v photo.jpg[Q=85]
exiftool -q -overwrite_original \
  -DateTimeOriginal="2024:05:01 12:34:56" -OffsetTimeOriginal="+08:00" -SubSecTimeOriginal=250 \
  -GPSLatitude=31.2304 -GPSLatitudeRef=N -GPSLongitude=121.4737 -GPSLongitudeRef=E \
  -Make=Apple -Model="iPhone 15 Pro" -LensModel="iPhone 15 Pro back camera" -Orientation#=6 photo.jpg
ffmpeg -v error -f lavfi -i testsrc2=size=1920x1080:rate=30 -f lavfi -i sine=frequency=440 -t 3 \
  -c:v libx265 -tag:v hvc1 -c:a aac -shortest -y video.mov
exiftool -q -overwrite_original -Keys:ContentIdentifier="TEST-CID-1234" \
  -Keys:CreationDate="2024:05:01 12:34:56+08:00" video.mov
rm -f base.v grad.v
ls -la
