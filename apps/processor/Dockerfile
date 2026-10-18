# 图片/视频处理。两个阶段共用同一套依赖和模型（lib.mjs），所以容器和设备端的结果完全一致：
#   最后一个阶段 processor：Cloudflare 容器。没有外网（enableInternet: false），只通过 Processor DO 收发数据。
#                         wrangler 构建默认的最后一个阶段，BuildKit 不会构建用不到的 device 阶段。
#   device：设备端处理（apps/device），在自己的电脑上用 docker compose 运行，见 apps/device/README.md。
#           需要命名构建上下文 device-src 和 shared-src（compose.yaml 的 additional_contexts）。
# 模型和依赖只在构建时下载，都固定了版本和校验和。
#
# 构建参数 NANA_FACES=on|off（默认 on）：off 时不下载人脸模型、不做人脸识别（人物页为空）。
#   InsightFace 的预训练权重只允许非商业使用；不能接受这个条件的部署者用 off（见 NOTICE）。
#   Cloudflare 容器由 Workers Builds 的构建变量 NANA_FACES 控制（render-wrangler.mjs 写进镜像的 build_vars），
#   设备端由 compose 的环境变量控制。两边要一致，否则设备处理的照片和云端处理的照片一部分有人脸、一部分没有。
ARG NANA_FACES=on

# 人脸检测（SCRFD det_10g，约 17 MB）和识别（ArcFace w600k_r50，约 174 MB），InsightFace buffalo_l，
# 用 Immich 导出的 ONNX（固定版本）。换模型时同时改 faces.mjs 的 FACE_MODEL_VER。
FROM node:24-trixie-slim AS faces-on
RUN mkdir -m 755 /out
ADD --chmod=644 --checksum=sha256:5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91 \
    https://huggingface.co/immich-app/buffalo_l/resolve/d09715916a0778919a770c343533641e250b8699/detection/model.onnx \
    /out/face-det.onnx
ADD --chmod=644 --checksum=sha256:4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43 \
    https://huggingface.co/immich-app/buffalo_l/resolve/d09715916a0778919a770c343533641e250b8699/recognition/model.onnx \
    /out/face-rec.onnx

FROM node:24-trixie-slim AS faces-off
RUN mkdir -m 755 /out

FROM faces-${NANA_FACES} AS faces

FROM node:24-trixie-slim AS base

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libvips-tools libheif-plugin-libde265 libheif-plugin-aomdec \
      libimage-exiftool-perl libraw-bin ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# onnxruntime-node：不下载 CUDA 等额外文件，只保留目标平台（Cloudflare 是 linux/x64，Apple Silicon 上的设备端是 linux/arm64）的二进制
ARG TARGETARCH
COPY package.json package-lock.json ./
RUN ONNX_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo x64) \
 && ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev \
 && find node_modules/onnxruntime-node/bin -mindepth 2 -maxdepth 2 ! -path '*/linux' -exec rm -rf {} + \
 && find node_modules/onnxruntime-node/bin -mindepth 3 -maxdepth 3 ! -path "*/$ONNX_ARCH" -exec rm -rf {} + \
 && npm cache clean --force

# 模型对所有用户可读（设备端用非 root 用户运行）。目录先建好、文件用 --chmod，不能事后 chmod：
# 那样会在新的一层里把约 280 MB 的模型再存一遍，镜像变大，部署和冷启动都变慢。
RUN mkdir -m 755 /app/model
# CLIP ViT-B/32 图像塔（int8 量化，约 89 MB），用来算相似度向量。换模型时同时改 lib.mjs 的 MODEL_VER。
ADD --chmod=644 --checksum=sha256:583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299 \
    https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/d15189d7028b43f1d3e65039190477f6af591c2a/onnx/vision_model_quantized.onnx \
    /app/model/clip-vision.onnx

# 人脸模型来自上面的 faces 阶段（NANA_FACES=off 时没有文件）。
COPY --from=faces /out/ /app/model/

COPY lib.mjs faces.mjs mask.mjs ./
ARG NANA_FACES
ENV NODE_ENV=production NANA_FACES=${NANA_FACES}

# ---- 设备端处理（只在本地构建）
FROM base AS device
# cloudflared：用主人自己的 Access 登录（cloudflared access login / token）。固定版本和校验和。
# cloudflared（Go）用系统证书库校验 TLS，slim 镜像里没有
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
ARG CLOUDFLARED_VERSION=2026.9.1
RUN set -e; \
    case "$TARGETARCH" in \
      arm64) sum=3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3 ;; \
      *) TARGETARCH=amd64; sum=03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc ;; \
    esac; \
    node -e 'fetch(process.argv[1]).then(async (r) => { if (!r.ok) throw new Error(r.status); require("fs").writeFileSync("/usr/local/bin/cloudflared", Buffer.from(await r.arrayBuffer())); })' \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${TARGETARCH}"; \
    echo "$sum  /usr/local/bin/cloudflared" | sha256sum -c -; \
    chmod +x /usr/local/bin/cloudflared
# 和仓库里一样的目录关系：/srv/device/*.mjs 用 ../processor/lib.mjs 引用处理代码（解析到 /app/lib.mjs 和 /app/node_modules）
RUN mkdir -p /srv/device && ln -s /app /srv/processor
COPY --from=device-src *.mjs package.json /srv/device/
# 和仓库里一样的相对路径：/srv/device/upload.mjs 用 ../../packages/shared/src/group.ts（Node 直接加载 .ts，不需要构建）
COPY --from=shared-src group.ts /packages/shared/src/group.ts
COPY --from=device-src public /srv/device/public
WORKDIR /srv/device
# 设置和 cloudflared 的登录凭据放在 volume 里（compose.yaml），用非 root 用户运行
RUN mkdir -p /data /home/node/.cloudflared && chown node:node /data /home/node/.cloudflared
USER node
# 多个任务并行时，每个 vips 进程只用 2 个线程，避免互相抢核
ENV VIPS_CONCURRENCY=2 NANA_DATA_DIR=/data
EXPOSE 7878
STOPSIGNAL SIGTERM
CMD ["node", "main.mjs"]

# ---- Cloudflare 容器（默认构建的最后一个阶段）
FROM base AS processor
COPY server.mjs ./
EXPOSE 8080
STOPSIGNAL SIGTERM
CMD ["node", "server.mjs"]
