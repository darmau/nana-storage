import { DurableObject } from "cloudflare:workers";
import {
	COMPRESS_JPEG_QUALITY,
	COMPRESS_MAX_BYTES,
	COMPRESS_MAX_DIFF,
	COMPRESS_MIN_SAVING,
	COMPRESS_TIMEOUT_MS,
	COMPOSE_JPEG_QUALITY,
	COMPOSE_MAX_EDGE,
	COMPOSE_MAX_PIXELS,
	COMPOSE_TIMEOUT_MS,
	CONTAINER_INACTIVITY_MS,
	FULL_PREVIEW_TIMEOUT_MS,
	IMAGE_JOB_TIMEOUT_MS,
	PREVIEW_LONG_EDGE,
	PRICING,
	PROCESSOR_POOL_SIZE,
	type ComposeDirection,
	type CropBox,
} from "@nana/shared";

/**
 * 每个 Processor DO 实例挂一个容器（libvips / exiftool / LibRaw / ffmpeg）。
 * 输入直接从 R2 读，输出直接写回 R2，大文件不经过 RPC。
 *
 * 成本规则：
 *  - 使用原生 ctx.container API，不用 @cloudflare/containers 的 Container 类，
 *    因为后者在容器运行期间会不断自我续期 alarm。这里没有任何 alarm：
 *    DO 空闲后，运行时会在 CONTAINER_INACTIVITY_MS 之后自动停掉容器；
 *    没有后续任务时，消费者还会在释放槽位之前调用 stopIfRunning() 立即停掉。
 *  - DO 管理的容器不支持 max_instances；只有池里的固定名字能启动容器，
 *    同时用几个由 UsageGuard 的槽位决定（见 processorStub）。
 *  - 容器没有外网（enableInternet: false），也没有公网入口。
 *  - 每次调用都有硬超时，超时就销毁容器，下一次调用会重新启动一个干净的。
 *  - 健康检查有次数上限，起不来就报错，不会无限重试。
 *  - 所有方法都返回 containerSeconds，由调用方记到 UsageGuard。
 */

const PORT = 8080;
const HEALTH_ATTEMPTS = 50; // × 200ms ≈ 10 秒
/** 自定义实例规格，和 PRICING.containers 一致（费用估算和月度熔断都按它算）。 */
const INSTANCE = {
	vcpu: PRICING.containers.vcpu,
	memoryMib: PRICING.containers.memoryGib * 1024,
	diskMb: PRICING.containers.diskGb * 1000,
};

/** 不用联合类型：RPC 包装后联合类型的判别会失效。ok 为 true 时 value 一定存在。 */
export interface Result<T> {
	ok: boolean;
	error?: string;
	value?: T;
	containerSeconds: number;
}

/** exiftool -json -n 的输出：扁平的标量值。 */
export type MetaRecord = Record<string, string | number | boolean | null>;

export interface DeriveInput {
	inputKey: string;
	kind: "image" | "raw" | "video";
	rotation: number;
	thumbKey: string;
	previewKey: string;
	/** 旋转只重做缩略图，指纹和人脸不变，不用再算。 */
	skipFingerprint?: boolean;
	/** 预览长边，默认 PREVIEW_LONG_EDGE；“加载原图”时是原图尺寸（见 fullPreviewEdge）。 */
	previewEdge?: number;
	/** 裁切框（相对于旋转之后的整张图）。有裁切时缩略图和预览是裁切后的，另外把未裁切的底图写到 baseKey。 */
	crop?: CropBox | null;
	/** 打码的笔画（shared 的 encodeMask），盖住的地方变成毛玻璃。有打码时同样把底图（不打码）写到 baseKey。 */
	mask?: string | null;
	baseKey?: string;
}
/** 容器算出的指纹（见 src/similar.ts）。容器那边算失败时为 null，不影响其他结果。 */
export interface Fingerprint {
	model: string;
	phash: string;
	/** 512 个 int8，base64 */
	embedding: string;
}
/** 容器算出的人脸（见 src/people.ts、apps/processor/faces.mjs）。算失败时为 null，不影响其他结果。 */
export interface FaceScan {
	model: string;
	faces: {
		/** 归一化到 0–1 的人脸框（用户旋转之前） */
		x: number;
		y: number;
		w: number;
		h: number;
		/** 人脸框短边在分析图里的像素数 */
		px: number;
		score: number;
		sharpness: number;
		/** 512 个 int8，base64 */
		embedding: string;
	}[];
	/** 所有头像横向拼成的 WebP（base64），没有脸时为 null */
	sprite: string | null;
}
export interface DeriveOutput {
	meta: MetaRecord;
	sha256: string;
	size: number;
	crc32: number;
	width: number;
	height: number;
	thumbSize: number;
	previewSize: number;
	fp: Fingerprint | null;
	faces: FaceScan | null;
}
export interface MetaOutput {
	meta: MetaRecord;
	sha256: string;
	size: number;
	crc32: number;
}
export interface TranscodeOutput {
	size: number;
}
/** 原图压缩（lib.mjs 的 compressTask）。sha256 / size 是输入的（完整性校验）；skipped 不为 null 时没有 out，也没有写 R2。 */
export interface CompressOutput {
	sha256: string;
	size: number;
	skipped: string | null;
	/** 原图存储方向的像素尺寸（旧版设备端没有） */
	width?: number | null;
	height?: number | null;
	/** width / height 是压缩后的（缩小过分辨率时和原图不同；旧版设备端没有） */
	out: { sha256: string; size: number; crc32: number; width?: number; height?: number } | null;
}

/** 拼接 / 切割的一个输入：原件（或只有 RAW 时的 RAW）和照片现在的旋转、裁切。 */
export interface ComposeInput {
	key: string;
	kind: "image" | "raw";
	rotation: number;
	crop: CropBox | null;
}
export type ComposeOp =
	| { mode: "stitch"; direction: ComposeDirection }
	| { mode: "split"; direction: ComposeDirection; from: number; to: number };
/** 拼接 / 切割（lib.mjs 的 composeTask）。inputs 是各个输入的校验和（完整性校验），out 是生成的 JPEG。 */
export interface ComposeOutput {
	inputs: { sha256: string; size: number; crc32: number }[];
	out: { sha256: string; size: number; crc32: number; width: number; height: number };
}

const poolName = (i: number) => `proc-${i}`;

export class Processor extends DurableObject<Env> {
	private starting: Promise<boolean> | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const container = ctx.container;
		// DO 重启后（比如部署）超时设置会丢失，需要重新设置。
		if (container?.running) {
			void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(CONTAINER_INACTIVITY_MS));
		}
	}

	/** 只有池里的几个 DO 名字才允许启动容器，防止 bug 生成任意多个容器。 */
	private isPoolMember(): boolean {
		for (let i = 0; i < PROCESSOR_POOL_SIZE; i++) {
			if (this.env.PROCESSOR.idFromName(poolName(i)).equals(this.ctx.id)) return true;
		}
		return false;
	}

	/** 返回值表示这次是否冷启动了一个新容器。 */
	private async ensureRunning(): Promise<boolean> {
		const container = this.ctx.container;
		if (!container) throw new Error("no container configured");
		let fresh = false;
		if (!container.running) {
			if (!this.isPoolMember()) throw new Error("processor instance is not in the pool");
			container.start({ image: container.images.base, instance: INSTANCE, enableInternet: false });
			fresh = true;
		}
		await container.setInactivityTimeout(CONTAINER_INACTIVITY_MS);

		const port = container.getTcpPort(PORT);
		let lastError: unknown;
		for (let i = 0; i < HEALTH_ATTEMPTS; i++) {
			try {
				const res = await port.fetch("http://container/health");
				if (res.ok) return fresh;
				lastError = new Error(`health ${res.status}`);
			} catch (e) {
				lastError = e;
			}
			await scheduler.wait(200);
		}
		await container.destroy(new Error("container failed health check")).catch(() => {});
		throw new Error("container did not become healthy", { cause: lastError });
	}

	/**
	 * 调用容器任务。handle 负责消费响应（必须在超时内完成）。
	 * 超时会中止请求并销毁容器。inputKeys 有几个时（拼接），请求体是这几个对象首尾相接。
	 */
	private async call<T>(
		task: string,
		inputKeys: string | string[],
		/** 也可以按输入对象的大小生成（拼接时容器要按大小把请求体切开） */
		headers: Record<string, string> | ((sizes: number[]) => Record<string, string>),
		timeoutMs: number,
		handle: (res: Response) => Promise<T>,
	): Promise<Result<T>> {
		const started = Date.now();
		// 空闲收尾时间事后结算：上一个容器在最后一个任务结束后最多再跑 CONTAINER_INACTIVITY_MS，
		// 实际停得更早时（下一次启动比这更早到来就说明它已经停了）只记实际间隔。
		// 这样无论运行时多久停掉空闲容器，记账都接近真实值，也不会因为高估而误触发熔断。
		let tailSeconds = 0;
		const seconds = () => (Date.now() - started) / 1000 + tailSeconds;
		const fail = (error: unknown): Result<T> => ({ ok: false, error: String(error).slice(0, 2000), containerSeconds: seconds() });

		const keys = typeof inputKeys === "string" ? [inputKeys] : inputKeys;
		const objects: R2ObjectBody[] = [];
		const cancelAll = () => Promise.all(objects.map((o) => o.body.cancel().catch(() => {})));
		for (const key of keys) {
			const object = await this.env.PHOTOS.get(key);
			if (!object) {
				await cancelAll();
				return fail(`missing object ${key}`);
			}
			objects.push(object);
		}
		const size = objects.reduce((n, o) => n + o.size, 0);

		try {
			this.starting ??= this.ensureRunning().finally(() => {
				this.starting = undefined;
			});
			if (await this.starting) {
				const lastEnd = await this.ctx.storage.get<number>("lastTaskEnd");
				if (lastEnd) tailSeconds = Math.min(CONTAINER_INACTIVITY_MS, Math.max(0, started - lastEnd)) / 1000;
			}
		} catch (e) {
			await cancelAll();
			return fail(e);
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error(`${task} timeout after ${timeoutMs}ms`)), timeoutMs);
		try {
			let body: ReadableStream<Uint8Array> = objects[0]!.body;
			if (objects.length > 1) {
				const fixed = new FixedLengthStream(size);
				void concatStreams(objects.map((o) => o.body))
					.pipeTo(fixed.writable)
					.catch(() => {});
				body = fixed.readable;
			}
			const res = await this.ctx.container!.getTcpPort(PORT).fetch(`http://container/tasks/${task}`, {
				method: "POST",
				body,
				headers: { ...(typeof headers === "function" ? headers(objects.map((o) => o.size)) : headers), "content-length": String(size) },
				signal: controller.signal,
			});
			if (!res.ok) return fail(`${task} ${res.status}: ${(await res.text()).slice(0, 1500)}`);
			const value = await handle(res);
			return { ok: true, value, containerSeconds: seconds() };
		} catch (e) {
			if (controller.signal.aborted) {
				// 卡住的任务：直接销毁容器，杜绝“永远在跑”的进程。
				await this.ctx.container?.destroy(new Error("task timeout")).catch(() => {});
			}
			return fail(e);
		} finally {
			clearTimeout(timer);
			await this.ctx.storage.put("lastTaskEnd", Date.now());
		}
	}

	/**
	 * 读元数据 + 生成缩略图和预览图，写入 R2。
	 * 全尺寸预览（previewEdge 大于默认值）可能有十几 MB：不走 base64 JSON，容器把 JSON 和预览字节接在一起返回，
	 * 预览部分直接流进 R2，不在内存里攒整份。
	 */
	async derive(input: DeriveInput): Promise<Result<DeriveOutput>> {
		const big = (input.previewEdge ?? PREVIEW_LONG_EDGE) > PREVIEW_LONG_EDGE;
		const httpMetadata = { contentType: "image/webp" };
		// 旧版容器（部署后镜像还没换完）不认 x-mask，会生成没打码的预览：写进 R2 之前报错，任务照常重试
		const checkMask = <B extends { mask?: string | null }>(body: B) => {
			if ((body.mask ?? null) !== (input.mask ?? null)) throw new Error("derive ignored the mask (outdated container)");
			return body;
		};
		return this.call(
			"derive",
			input.inputKey,
			{
				"x-kind": input.kind,
				"x-rotation": String(input.rotation),
				...(input.crop ? { "x-crop": [input.crop.x, input.crop.y, input.crop.w, input.crop.h].join(",") } : {}),
				...(input.mask ? { "x-mask": input.mask } : {}),
				...(input.skipFingerprint ? { "x-fingerprint": "skip" } : {}),
				...(big ? { "x-preview-edge": String(input.previewEdge), "x-preview-transport": "stream" } : {}),
			},
			big ? FULL_PREVIEW_TIMEOUT_MS : IMAGE_JOB_TIMEOUT_MS,
			async (res) => {
				type Body = Omit<DeriveOutput, "thumbSize" | "previewSize"> & {
					thumb: string;
					preview?: string;
					base?: string | null;
					mask?: string | null;
				};
				let body: Body;
				let previewSize: number;
				if (big) {
					const total = Number(res.headers.get("content-length"));
					const jsonLength = Number(res.headers.get("x-json-length"));
					if (!res.body || !(total > jsonLength && jsonLength > 0)) throw new Error("derive returned a malformed stream");
					const { head, rest } = await splitStream(res.body, jsonLength);
					body = checkMask(JSON.parse(new TextDecoder().decode(head)) as Body);
					const fixed = new FixedLengthStream(total - jsonLength);
					const [, written] = await Promise.all([
						rest.pipeTo(fixed.writable),
						this.env.PHOTOS.put(input.previewKey, fixed.readable, { httpMetadata }),
					]);
					previewSize = written.size;
				} else {
					body = checkMask(await res.json<Body>());
					const preview = base64ToBytes(body.preview ?? "");
					await this.env.PHOTOS.put(input.previewKey, preview, { httpMetadata });
					previewSize = preview.byteLength;
				}
				const thumb = base64ToBytes(body.thumb);
				await this.env.PHOTOS.put(input.thumbKey, thumb, { httpMetadata });
				if ((input.crop || input.mask) && input.baseKey) {
					if (!body.base) throw new Error("derive returned no base image");
					await this.env.PHOTOS.put(input.baseKey, base64ToBytes(body.base), { httpMetadata });
				}
				return {
					meta: body.meta,
					sha256: body.sha256,
					size: body.size,
					crc32: body.crc32,
					width: body.width,
					height: body.height,
					thumbSize: thumb.byteLength,
					previewSize,
					fp: body.fp ?? null,
					faces: body.faces ?? null,
				};
			},
		);
	}

	/** 只读元数据和校验和（用于 RAW 附件、Live Photo 的视频部分）。 */
	async meta(inputKey: string): Promise<Result<MetaOutput>> {
		return this.call("meta", inputKey, {}, IMAGE_JOB_TIMEOUT_MS, async (res) => res.json<MetaOutput>());
	}

	/** 转码成 H.264 预览，流式写入 R2。 */
	async transcode(inputKey: string, outputKey: string, timeoutMs: number): Promise<Result<TranscodeOutput>> {
		return this.call(
			"transcode",
			inputKey,
			{ "x-timeout-ms": String(timeoutMs - 10_000) },
			timeoutMs,
			async (res) => {
				const length = Number(res.headers.get("content-length"));
				if (!res.body || !Number.isFinite(length) || length <= 0) throw new Error("transcode returned no body");
				const fixed = new FixedLengthStream(length);
				const [, written] = await Promise.all([
					res.body.pipeTo(fixed.writable),
					this.env.PHOTOS.put(outputKey, fixed.readable, { httpMetadata: { contentType: "video/mp4" } }),
				]);
				return { size: written.size };
			},
		);
	}

	/**
	 * 原图压缩：容器返回 JSON + 压缩后的 JPEG，后半段直接流进 R2 的 outputKey（一个新 key，原图不动）。
	 * R2 按容器算的 sha256 校验写入的字节，对不上就写入失败。是否换掉原图由调用方（src/compress.ts）决定。
	 */
	async compress(inputKey: string, outputKey: string, maxPixels = 0): Promise<Result<CompressOutput>> {
		return this.call(
			"compress",
			inputKey,
			{
				"x-quality": String(COMPRESS_JPEG_QUALITY),
				"x-min-saving": String(COMPRESS_MIN_SAVING),
				"x-max-bytes": String(COMPRESS_MAX_BYTES),
				"x-max-diff": String(COMPRESS_MAX_DIFF),
				"x-max-pixels": String(maxPixels),
			},
			COMPRESS_TIMEOUT_MS,
			async (res) => {
				const total = Number(res.headers.get("content-length"));
				const jsonLength = Number(res.headers.get("x-json-length"));
				if (!res.body || !(total >= jsonLength && jsonLength > 0)) throw new Error("compress returned a malformed stream");
				const { head, rest } = await splitStream(res.body, jsonLength);
				const body = JSON.parse(new TextDecoder().decode(head)) as CompressOutput;
				if (!body.out) {
					await rest.cancel().catch(() => {});
					return { ...body, skipped: body.skipped ?? "unknown", out: null };
				}
				if (total - jsonLength !== body.out.size) throw new Error("compress returned a wrong length");
				const fixed = new FixedLengthStream(body.out.size);
				const [, written] = await Promise.all([
					rest.pipeTo(fixed.writable),
					this.env.PHOTOS.put(outputKey, fixed.readable, { httpMetadata: { contentType: "image/jpeg" }, sha256: body.out.sha256 }),
				]);
				if (written.size !== body.out.size) throw new Error("compress output size mismatch");
				return { ...body, skipped: null };
			},
		);
	}

	/**
	 * 拼接 / 切割：几个输入首尾相接发给容器，容器返回 JSON + 生成的 JPEG，后半段直接流进 R2 的 outputKey（一个新 key）。
	 * R2 按容器算的 sha256 校验写入的字节。要不要用它由调用方（src/compose.ts）决定。
	 */
	async compose(inputs: ComposeInput[], op: ComposeOp, outputKey: string): Promise<Result<ComposeOutput>> {
		const specs = inputs.map((i) => ({ kind: i.kind, rotation: i.rotation, crop: i.crop && [i.crop.x, i.crop.y, i.crop.w, i.crop.h].join(",") }));
		return this.call(
			"compose",
			inputs.map((i) => i.key),
			(sizes) => ({
				"x-inputs": JSON.stringify(specs.map((s, n) => ({ ...s, size: sizes[n] }))),
				"x-op": JSON.stringify(op),
				"x-quality": String(COMPOSE_JPEG_QUALITY),
				"x-max-pixels": String(COMPOSE_MAX_PIXELS),
				"x-max-edge": String(COMPOSE_MAX_EDGE),
			}),
			COMPOSE_TIMEOUT_MS,
			async (res) => {
				const total = Number(res.headers.get("content-length"));
				const jsonLength = Number(res.headers.get("x-json-length"));
				if (!res.body || !(total > jsonLength && jsonLength > 0)) throw new Error("compose returned a malformed stream");
				const { head, rest } = await splitStream(res.body, jsonLength);
				const body = JSON.parse(new TextDecoder().decode(head)) as ComposeOutput;
				if (total - jsonLength !== body.out.size) throw new Error("compose returned a wrong length");
				const fixed = new FixedLengthStream(body.out.size);
				const [, written] = await Promise.all([
					rest.pipeTo(fixed.writable),
					this.env.PHOTOS.put(outputKey, fixed.readable, { httpMetadata: { contentType: "image/jpeg" }, sha256: body.out.sha256 }),
				]);
				if (written.size !== body.out.size) throw new Error("compose output size mismatch");
				return body;
			},
		);
	}

	/**
	 * 没有后续任务时立即停掉容器，省掉空闲超时那段空转。只能由持有这个槽位的消费者在释放槽位之前调用，
	 * 这样不会打断别的任务。停掉之后清掉 lastTaskEnd，下次冷启动就不再补记空转时间。
	 */
	async stopIfRunning(): Promise<boolean> {
		const container = this.ctx.container;
		if (!container?.running) return false;
		await container.destroy();
		await this.ctx.storage.delete("lastTaskEnd");
		return true;
	}
}

/**
 * 读出流的前 n 个字节，剩下的部分（包括已经读进来的多余字节）作为新的流返回。
 * 流在 n 字节之前就结束了会抛错。
 */
export async function splitStream(
	stream: ReadableStream<Uint8Array>,
	n: number,
): Promise<{ head: Uint8Array; rest: ReadableStream<Uint8Array> }> {
	const reader = stream.getReader();
	const head = new Uint8Array(n);
	let filled = 0;
	let extra: Uint8Array | null = null;
	while (filled < n) {
		const { done, value } = await reader.read();
		if (done) throw new Error("stream ended early");
		const take = Math.min(n - filled, value.byteLength);
		head.set(value.subarray(0, take), filled);
		filled += take;
		if (take < value.byteLength) extra = value.subarray(take);
	}
	const rest = new ReadableStream<Uint8Array>({
		start(controller) {
			if (extra) controller.enqueue(extra);
		},
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	return { head, rest };
}

/** 几个流按顺序首尾相接成一个。取消时把还没读完的都取消掉。 */
export function concatStreams(streams: ReadableStream<Uint8Array>[]): ReadableStream<Uint8Array> {
	let i = 0;
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			while (i < streams.length) {
				reader ??= streams[i]!.getReader();
				const { done, value } = await reader.read();
				if (!done) {
					controller.enqueue(value);
					return;
				}
				reader = null;
				i++;
			}
			controller.close();
		},
		async cancel(reason) {
			await reader?.cancel(reason);
			for (const s of streams.slice(reader ? i + 1 : i)) await s.cancel(reason).catch(() => {});
		},
	});
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/**
 * slot 来自 UsageGuard.acquireSlot()，同一时间每个 Processor 只分给一个任务。
 * 只会用到固定的 PROCESSOR_POOL_SIZE 个 DO 名字，这就是容器数量的硬上限。
 */
export function processorStub(env: Env, slot: number) {
	if (!Number.isInteger(slot) || slot < 0 || slot >= PROCESSOR_POOL_SIZE) throw new Error(`bad processor slot ${slot}`);
	return env.PROCESSOR.get(env.PROCESSOR.idFromName(poolName(slot)));
}
