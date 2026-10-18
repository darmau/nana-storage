/**
 * 成本防护只防失控，不按天限制正常用量：每天的容器时长、任务数、上传量只记账和显示。
 * 硬上限是本月（UTC 自然月）容器的估算超额费用（containerCost()，按满载算，比实际账单偏高），
 * 达到月度上限就熔断。默认 DEFAULT_MONTHLY_BUDGET_USD，可以在设置页修改（存在 UsageGuard 里，不会过期）。
 * 其他服务（Workers / DO / D1 / R2）按次计费的部分由 wrangler.jsonc 的速率上限封顶，不熔断。
 */
export const DEFAULT_MONTHLY_BUDGET_USD = 10;
/** 设置页能设的月度上限范围，防止手误填成天文数字。 */
export const MIN_MONTHLY_BUDGET_USD = 1;
export const MAX_MONTHLY_BUDGET_USD = 500;
/** 用到上限的这个比例时，设置页标成警示色。 */
export const BUDGET_WARN_RATIO = 0.8;

/** 同时运行的容器数默认值。批量导入时可以在设置页临时调高（最长 MAX_PROCESSORS_OVERRIDE_MS），最多 PROCESSOR_POOL_SIZE。 */
export const DEFAULT_PROCESSORS = 4;

/** 临时调高容器数，最长保持这么久。 */
export const MAX_PROCESSORS_OVERRIDE_MS = 7 * 24 * 3600 * 1000;

/**
 * 同一个条目一小时内的容器运行次数上限，超过就熔断（说明出现了循环）。分两种算：
 *  - 自动重试（任务的第 2、3 次尝试）：正常情况一个任务最多 2 次，超过 MAX_RETRIES_PER_ASSET_PER_HOUR 说明重试计数出了问题；
 *  - 全部运行（包括旋转、加载原图、手动重试这些用户操作新建的任务）：上限宽得多，只拦住前端或建任务的代码失控。
 *    同一条目同时只有一个排队的 rotate 任务，每次最多 FULL_PREVIEW_TIMEOUT_MS，所以最坏每条目每小时约 1.5 小时容器时间，
 *    之后由熔断和月度上限兜底。
 */
export const MAX_PROCESS_PER_ASSET_PER_HOUR = 30;
export const MAX_RETRIES_PER_ASSET_PER_HOUR = 6;

/** 任务最多尝试次数，之后只能手动重试。 */
export const MAX_JOB_ATTEMPTS = 3;

/** 处理中的任务超过这么久没有结束，就视为卡死。 */
export const JOB_STALE_MS = 20 * 60 * 1000;

/** 恢复熔断后每批重新入队的最大任务数。 */
export const RESUME_BATCH = 500;

/**
 * 设备端处理（apps/device，src/device.ts）：主人的电脑用自己的 Access 登录拉取任务，在本地处理后写回。
 *  - 租约：设备每次认领任务都续租 DEVICE_LEASE_MS。租约有效时队列消费者直接 ack，任务留在 D1 等设备拉取；
 *    设备消失后租约自动失效，新的消息回到容器。被 ack 掉的任务由每小时 Cron 补发（requeuePending，每次 RESUME_BATCH 个）。
 *  - 设备开着就一直接管：空闲时每 DEVICE_POLL_MS 认领一次（同时续租），每天约 8640 次请求 + 少量 D1 读取，每月不到 $0.1。
 *  - 每次最多认领 DEVICE_CLAIM_MAX 个任务，任务仍受 MAX_JOB_ATTEMPTS 和 UsageGuard 的循环熔断约束。
 */
export const DEVICE_LEASE_MS = 2 * 60_000;
export const DEVICE_POLL_MS = 10_000;
export const DEVICE_CLAIM_MAX = 16;
/** 设备上传的单个派生文件上限（全尺寸预览、5 分钟以内视频的 H.264 预览都远小于它）。 */
export const DEVICE_OUTPUT_MAX_BYTES = 2 * 1024 ** 3;
/**
 * 设备在本机找到了原件（文件名 + 大小 + sha256 都对上）时不下载，改由 Worker 在机房里对 R2 上的对象算一次 sha256
 * （代替容器路径的完整性校验：上传时读盘出错的话，本地文件对得上、R2 上的却是坏的）。
 * 每个输入每次认领最多一次，SHA-256 约 0.5 GB/s：2 GB 最多约 4–5 秒 CPU（cpu_ms 上限 30 秒），费用可以忽略；更大的照旧下载。
 */
export const DEVICE_VERIFY_MAX_BYTES = 2 * 1024 ** 3;

/**
 * 容器数的硬上限：Processor 只会用 proc-0 … proc-(N-1) 这几个 DO 名字，池外的名字拒绝启动容器。
 * 实际同时运行几个由 UsageGuard 分配槽位（默认 DEFAULT_PROCESSORS，临时调高最多到这里）。
 * 最坏情况：32 个容器（1 vCPU / 3 GiB）满载约 $3.2/小时，总量受月度费用上限约束（所有容器的时长加在一起算）：
 * 达到上限后最多再多出正在跑的任务（每个最多 15 分钟，32 个约 $1）。
 * 队列的 max_concurrency 要和它保持一致（wrangler.jsonc）。
 */
export const PROCESSOR_POOL_SIZE = 32;

/**
 * 拿不到容器槽位时，队列消费者在 UsageGuard 里最多等这么久（不轮询，槽位释放时直接唤醒），
 * 超时就把消息延迟后放回队列（不算任务的尝试次数）。消费者单次最多运行 15 分钟，等得越久，
 * 留给转码的时间越少（见 jobDeadline）。
 */
export const SLOT_WAIT_MS = 5 * 60_000;

/** 槽位租约：持有者异常退出时，最多这么久后自动收回。比消费者的 15 分钟上限略长。 */
export const SLOT_LEASE_MS = 16 * 60_000;

/** 队列消费者单次调用的墙钟上限是 15 分钟，任务要在这之前结束，留 30 秒收尾。 */
export const CONSUMER_BUDGET_MS = 14.5 * 60_000;

/**
 * 容器空闲多久后由运行时停止（兜底）。空转也按配置的内存（3 GiB）计费，所以尽量短：
 * 批量处理时任务一个接一个，间隔远小于这个值；没有后续任务时消费者会直接停掉容器（见 UPLOAD_ACTIVE_MS）。
 */
export const CONTAINER_INACTIVITY_MS = 30 * 1000;

/**
 * 任务结束时，如果没有排队的任务，且这么久之内没有新建上传，就立即停掉容器，不等空闲超时。
 * 有新上传说明后续任务可能马上就来，这时交给 CONTAINER_INACTIVITY_MS，避免反复冷启动。
 */
export const UPLOAD_ACTIVE_MS = 2 * 60 * 1000;

/** 单个任务的硬超时。 */
export const IMAGE_JOB_TIMEOUT_MS = 60_000;

/**
 * 超过这些就不转码，只保留原件（Safari/Mac 可以直接播放 HEVC 原件）。
 * 队列消费者单次最多运行 15 分钟，1 vCPU 转码长视频必然超时，超时还会白白重试，所以限制得比较紧。
 */
export const MAX_TRANSCODE_BYTES = 2 * 1024 ** 3;
export const MAX_TRANSCODE_DURATION_MS = 5 * 60 * 1000;

/** 转码超时：1 分钟起步，每秒视频再给 4 秒，最多 12 分钟。 */
export const transcodeTimeoutMs = (durationMs: number) =>
	Math.min(12 * 60_000, 60_000 + Math.ceil(durationMs / 1000) * 4000);

/** 上传分块大小（Worker 请求体上限是 100 MB）。 */
export const UPLOAD_PART_BYTES = 20 * 1024 ** 2;

/**
 * 预览图长边（apps/processor/lib.mjs 的 PREVIEW_EDGE 要保持一致）。3840 覆盖 4K 显示器和 iPad 全屏。
 * assets.preview_edge 记录生成时的尺寸。改大之后旧照片的预览不会自动重做（只有旋转会重新生成）。
 */
export const PREVIEW_LONG_EDGE = 3840;

/**
 * “加载原图”：浏览器解不了原件（非 Safari 上的 HEIC、RAW、TIFF 等，或者原件太大）时，按原图分辨率重新生成预览，
 * 直接替换原来的预览（assets.preview_target 记下要的尺寸，旋转 / 重新处理时保持）。
 * 最多 FULL_PREVIEW_MAX_PIXELS 像素（和查看器直接解码原图的上限一致，手机上解码不至于吃不消），长边不超过 WebP 的上限。
 * 只由用户在查看器里点击（或开着原图模式停留在照片上）触发，每张 1 次 rotate 任务；生成过就不会再触发。
 */
export const FULL_PREVIEW_MAX_PIXELS = 60_000_000;
export const WEBP_MAX_EDGE = 16383;
/** 生成全尺寸预览的硬超时（解码 + WebP 编码几千万像素，1 vCPU 上要十几到几十秒）。 */
export const FULL_PREVIEW_TIMEOUT_MS = 3 * 60_000;

/** 原图分辨率的预览长边：不超过原图，也不超过上面两个上限；不会小于普通预览。w/h 未知时返回 null。 */
export function fullPreviewEdge(w: number | null | undefined, h: number | null | undefined): number | null {
	if (!w || !h || w <= 0 || h <= 0) return null;
	const long = Math.max(w, h);
	const byPixels = Math.floor(long * Math.sqrt(FULL_PREVIEW_MAX_PIXELS / (w * h)));
	return Math.max(PREVIEW_LONG_EDGE, Math.min(long, WEBP_MAX_EDGE, byPixels));
}

/** 每次 Cron 最多清理的回收站条目数。 */
export const PURGE_BATCH = 1000;
export const TRASH_RETENTION_MS = 30 * 24 * 3600 * 1000;

/**
 * 相同 / 相似照片（src/similar.ts）。
 * 指纹在 process 任务的那 1 次 derive 里一起算出来，不增加容器调用。
 */
export const FP_MODEL_VER = "clip-b32-q8"; // 和 apps/processor/lib.mjs 的 MODEL_VER 一致
export const FP_DIMS = 512;

/** 感知哈希的汉明距离不超过这么多就算同一张图（缩放、重新压缩、换格式、轻微裁剪）。和 asset_fp 的 5 段拆分配套，不能超过 4。 */
export const DUPLICATE_MAX_HAMMING = 4;
/**
 * 感知哈希只看 32×32 的明暗分布，同一场景连拍的几张（没有亚秒时间、没被连拍分组的）也会落在上面的距离以内，所以还要满足：
 *  - 两张都有相机 EXIF 时，拍摄时间相差不超过 DUPLICATE_SAME_CAPTURE_MS（副本会保留原始拍摄时间；
 *    时区丢失造成的整刻钟差也算同一时刻）；
 *  - 两张都有 CLIP 向量时，余弦相似度至少 DUPLICATE_MIN_COSINE（重新压缩 / 缩放的副本通常在 0.98 以上）。
 */
export const DUPLICATE_SAME_CAPTURE_MS = 1000;
export const DUPLICATE_MIN_COSINE = 0.96;
/** 为了比较向量，最多读这么多张照片的 CLIP 向量（每张 512 字节）；超出的部分只按哈希和时间判断。 */
export const DUPLICATE_EMBED_MAX = 20_000;
/** 一次“标记为不是重复”最多涉及的照片数（两两之间都记一条，50 张约 1200 条）。 */
export const DUPLICATE_IGNORE_MAX = 50;
/**
 * 候选重复对存在 duplicate_pairs 里，写指纹时增量维护：按 5 段哈希的索引查近邻，每张最多看 DUPLICATE_NEIGHBOR_MAX 个
 * （全黑、全白这类哈希相同的照片很多时也有上限）。5 万张时每张约 30 行 D1 读取。
 */
export const DUPLICATE_NEIGHBOR_MAX = 1000;
/**
 * 部署前写入的指纹（或增量维护失败之后）由第一次打开“整理重复”时的全量扫描补上：按 ID 分页读哈希，
 * 每页 DUPLICATE_SCAN_PAGE 行，最多 DUPLICATE_SCAN_MAX 行（约 30 MB 内存、几百毫秒 CPU）。5 万张时约 5 万行 D1 读取，只发生一次。
 */
export const DUPLICATE_SCAN_PAGE = 10_000;
export const DUPLICATE_SCAN_MAX = 200_000;

/** 相似照片：Vectorize 取前 SIMILAR_TOP_K 个，余弦相似度至少 SIMILAR_MIN_SCORE。 */
export const SIMILAR_TOP_K = 30;
export const SIMILAR_MIN_SCORE = 0.85;

/**
 * 自定义主题：最多 SMART_SET_MAX 个，每个最多 SMART_SET_MAX_EXAMPLES 个样本（正 + 负）。
 * 每个主题是一个逻辑回归分类器（apps/worker/src/smartset-model.ts），分数 p 在 0–1 之间。它只负责建议，
 * 照片放进哪个相册由用户在“结果”里手动挑，所以样本保持小规模。
 * 标记样本不会重新训练；用户点“更新”时才训练并扫描全库（不用 Vectorize）：
 *  - 读取约 SMART_SET_BACKGROUND 行（背景）+ 全部指纹行（5 万张时约 5 万行，每页 SMART_SET_SCAN_PAGE 行）。
 *    D1 每月含 250 亿行读取，每天更新 1000 次也只有每月 15 亿行；超出后每次约 $0.00005。
 *  - 写入：删掉旧建议、写入新建议（最多 SMART_SET_SUGGESTION_MAX 条），加上两个索引和缓存版本触发器，
 *    最坏约 8 万行；再加上样本分数约 2000 行。D1 每月含 5000 万行写入，每天更新 20 次也在额度内；超出后每次约 $0.08。
 *    更新只由用户点击或“标记有变化”后的 Cron 触发（每小时最多 SMART_SET_CRON_BATCH 个），没有标记就不会重跑。
 *  - Worker CPU：训练一次约 0.1 秒；正例、反例都至少 SMART_SET_CV_MIN 张时再做 SMART_SET_CV_FOLDS 折交叉验证，
 *    一共 6 次训练，最坏约 1 秒；打分 5 万张约 0.1 秒。
 *  - 同一个主题同时只跑一次（锁 SMART_SET_REFRESH_LOCK_MS 后自动过期）。
 * 新照片处理完后和每个主题算一次点积（100 × 512 次乘法），不读全库。
 */
export const SMART_SET_MAX = 100;
export const SMART_SET_MAX_EXAMPLES = 1000;
/** 训练时从全库随机抽的背景照片数。 */
export const SMART_SET_BACKGROUND = 300;
/** 分数达到这个值才进“建议”。 */
export const SMART_SET_SUGGEST_FLOOR = 0.3;
/** 每个主题最多保留这么多条建议（分数最高的）。 */
export const SMART_SET_SUGGESTION_MAX = 10_000;
/**
 * 标签和分类器矛盾的样本：正例的分数低于 positiveBelow，或者反例的分数不低于 negativeFrom。
 * 通常是点错了，或者 CLIP 认不出来的构图（主体在竖图的边缘），最容易把分类器带偏。
 */
export const SMART_SET_CONFLICT = { positiveBelow: SMART_SET_SUGGEST_FLOOR, negativeFrom: 0.7 } as const;
/** 正例、反例都至少这么多张才做交叉验证（太少时算出来的比例没有参考价值）。 */
export const SMART_SET_CV_MIN = 10;
export const SMART_SET_CV_FOLDS = 5;
/** 建议页的灵敏度：严格 / 标准 / 宽松 对应的最低分数。 */
export const SMART_SET_SENSITIVITY = { strict: 0.8, normal: 0.5, loose: SMART_SET_SUGGEST_FLOOR } as const;
export const SMART_SET_SCAN_PAGE = 1000;
export const SMART_SET_REFRESH_LOCK_MS = 60_000;

/**
 * 每小时 Cron 自动更新标记有变化的主题（和点“更新建议”一样），每次最多 SMART_SET_CRON_BATCH 个，逐个运行，熔断时跳过。
 * 标记在 SMART_SET_CRON_QUIET_MS 内还有变化的先不动，等用户标完。没有变化的主题不重跑（新照片处理完时已经打过分），不会自我触发。
 * 最坏情况每天 24 × 3 = 72 次全库扫描，5 万张时约 360 万行 D1 读取，在每月 250 亿行的额度内。
 */
export const SMART_SET_CRON_BATCH = 3;
export const SMART_SET_CRON_QUIET_MS = 10 * 60_000;

/**
 * Vectorize 补写：写入失败的（asset_fp.indexed = 0）由每小时的 Cron 补写，每次最多这么多条，不会自我触发。
 * 最坏情况每天 24 × 500 = 1.2 万次写入，Vectorize 按存储的维度计费，写入本身几乎不花钱。
 */
export const VECTOR_SYNC_BATCH = 500;

/**
 * 人物（人脸识别，src/people.ts）。
 * 人脸在 process 任务的那 1 次 derive 里一起算（SCRFD 检测 + ArcFace 识别，apps/processor/faces.mjs），不增加容器调用；
 * 每张照片多约 0.3 秒 + 每张脸约 0.1–0.2 秒容器时间。
 */
export const FACE_MODEL_VER = "buffalo_l"; // 和 apps/processor/faces.mjs 的 FACE_MODEL_VER 一致
export const FACE_DIMS = 512;

/** 参与识别的脸：检测置信度至少 FACE_MIN_SCORE，人脸框短边至少 FACE_MIN_PX（分析图里的像素）。更小、更不确定的只记录，不归入人物。 */
export const FACE_MIN_SCORE = 0.7;
export const FACE_MIN_PX = 36;

/**
 * 归入人物（类似 DBSCAN，和 Immich 的做法一样）：
 *  - 余弦相似度至少 FACE_MATCH_MIN 的两张脸算“像”。每张脸查 Vectorize 里最像的 FACE_MATCH_TOP_K 张。
 *  - 自己加上像的脸至少 FACE_CORE_MIN 张时是“核心”：附近有人物就归入（附近的脸按人物投票，相似度相加，得票最多的），
 *    没有就新建一个未命名的人物，并把附近还没有人物的脸一起归进去。否认过的人物（face_rejects）里的脸不算附近的脸。
 *  - 不是核心、附近也没有人物的先推迟（state 1），由 Cron 再看一次，那时仍然没有就不归入（state 2）。
 * 每张脸 1 次 Vectorize 查询 + 1 次 D1 查询。
 */
export const FACE_MATCH_MIN = 0.5;
export const FACE_MATCH_TOP_K = 20;
export const FACE_CORE_MIN = 3;

/**
 * 每小时 Cron 处理推迟的和还没识别的脸（新照片的脸在 process 任务里当场识别），每次最多 FACE_CRON_BATCH 张，熔断时跳过，不会自我触发。
 * 最坏情况每天 24 × 300 = 7200 次 Vectorize 查询（5 万张脸的库每次查询约 512 维：每天约 370 万查询维度，在每月 5000 万的额度内）。
 * Vectorize 补写（faces.indexed = 0）同样每次最多 FACE_CRON_BATCH 条。
 */
export const FACE_CRON_BATCH = 300;

/**
 * “这不是 X”之后移出来的脸改回待识别，请求里当场重新识别最多这么多张（每张 1 次 Vectorize 查询，只由用户操作触发），
 * 剩下的由每小时的 Cron 处理（同样受 FACE_CRON_BATCH 限制）。
 */
export const FACE_REJECT_RECOGNIZE_MAX = 30;

/** 未命名的人物至少有这么多张照片才显示在人物列表里（太少的多半是路人）。已命名的总是显示。 */
export const PEOPLE_MIN_ASSETS = 3;

/**
 * “确认更多照片”：用人物最有代表性的最多 FACE_REVIEW_SEEDS 张脸各查一次 Vectorize（前 FACE_REVIEW_TOP_K 个），
 * 相似度至少 FACE_REVIEW_MIN（比自动归入宽松）、还没有人物、没被否认过的脸作为候选。只在用户打开时查询。
 */
export const FACE_REVIEW_SEEDS = 5;
export const FACE_REVIEW_TOP_K = 50;
export const FACE_REVIEW_MIN = 0.35;
export const FACE_REVIEW_MAX = 30;

// ---------------------------------------------------------------- 统计数据页（/stats）

/** 快照里保留最近多少天的每日张数（“一年内”按周汇总）。 */
export const LIBRARY_STATS_DAYS = 366;
/** 快照里最多保留多少个拍摄设备。 */
export const LIBRARY_STATS_CAMERAS = 100;
/** 最大的照片 / 视频各列出多少个。 */
export const LARGEST_MAX = 50;
