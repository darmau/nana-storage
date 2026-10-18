import { type CropBox, FULL_PREVIEW_MAX_PIXELS, PREVIEW_LONG_EDGE, cropOf, croppedSize, fullPreviewEdge, rotateBox } from "@nana/shared";
import type { AssetDetail } from "./types";

/** 浏览器能否直接解码 HEVC（Safari、带硬件解码的 Chrome/Edge）。 */
export const canPlayHevc = (() => {
	if (typeof document === "undefined") return false;
	const v = document.createElement("video");
	return v.canPlayType('video/mp4; codecs="hvc1"') !== "" || v.canPlayType('video/quicktime; codecs="hvc1"') !== "";
})();

const fileUrl = (id: string, role: string, rev?: number) => `/api/a/${id}/${role}${rev !== undefined ? `?v=${rev}` : ""}`;

/**
 * 视频播放候选地址，按优先级排列；前一个播放出错就换下一个。
 * 能解码 HEVC 的浏览器直接播原件（画质最好），否则用 H.264 预览。
 */
export function videoSources(a: AssetDetail): string[] {
	const role = a.kind === "live" ? "live_video" : "original";
	const original = a.files.find((f) => f.role === role);
	const preview = a.files.find((f) => f.role === "video_preview");
	const originalPlayable = original && /^video\/(mp4|quicktime)$/.test(original.mime);
	const out: string[] = [];
	if (original && originalPlayable && canPlayHevc) out.push(fileUrl(a.id, role));
	if (preview) out.push(fileUrl(a.id, "video_preview", a.derived_rev));
	if (original && !out.includes(fileUrl(a.id, role))) out.push(fileUrl(a.id, role));
	return out;
}

export const downloadUrl = (id: string, role: string) => `/api/a/${id}/${role}?download=1`;

/** 超过这些就不在浏览器里解码原图（手机上内存吃紧），只用预览。 */
const MAX_ORIGINAL_BYTES = 40 * 1024 ** 2;
const MAX_ORIGINAL_PIXELS = FULL_PREVIEW_MAX_PIXELS;

/** 只有 Safari 能直接显示 HEIC；Chrome / Firefox 下载了也解不开，干脆不请求。 */
const isSafari = typeof navigator !== "undefined" && /^((?!chrome|chromium|crios|fxios|edg|android).)*safari/i.test(navigator.userAgent);
let heicBroken = false;
/** HEIC 原图解码失败过一次，这次会话里就不再尝试。 */
export const markHeicBroken = () => {
	heicBroken = true;
};

/**
 * “加载原图”怎么做：
 *  - best：预览已经是原图分辨率（或者全尺寸预览的上限），提示“已经是最高清”；
 *  - direct：浏览器能直接解码原件、又不至于大到解码困难，直接把原件叠在预览上；
 *  - upgrade：请服务端按原图分辨率重新生成预览（替换原来的预览），生成好再叠上去。
 * 视频、尺寸未知的返回 null。
 */
export type HdPlan = { kind: "best" } | { kind: "direct"; url: string; heic: boolean } | { kind: "upgrade" };

export function hdPlan(a: AssetDetail): HdPlan | null {
	if (a.kind === "video") return null;
	const full = fullPreviewEdge(a.width, a.height);
	if (!full) return null;
	if (full <= (a.preview_edge ?? PREVIEW_LONG_EDGE)) return { kind: "best" };
	const f = a.files.find((x) => x.role === "original");
	if (!f) return { kind: "upgrade" };
	const heic = /^image\/hei[cf]$/.test(f.mime);
	const decodable = /^image\/(jpeg|png|webp|avif|gif)$/.test(f.mime) || (heic && isSafari && !heicBroken);
	if (!decodable || f.size > MAX_ORIGINAL_BYTES || a.width! * a.height! > MAX_ORIGINAL_PIXELS) return { kind: "upgrade" };
	return { kind: "direct", url: fileUrl(a.id, "original"), heic };
}

/**
 * 查看器里可以替换预览的原图地址：浏览器能直接解码、比预览大、又不至于大到解码困难。
 * 不满足就返回 null，继续只用预览。
 */
export function originalImageUrl(a: AssetDetail): { url: string; heic: boolean } | null {
	const plan = hdPlan(a);
	return plan?.kind === "direct" ? { url: plan.url, heic: plan.heic } : null;
}

export type FaceBox = CropBox;

/**
 * 人脸框（0–1，按用户旋转之前的照片）换算到顺时针转过 rotation 度的预览上。
 * 和 vips rot / CSS rotate 的方向一致。
 */
export const rotateFaceBox = (b: FaceBox, rotation: number): FaceBox => rotateBox(b, rotation);

/** 旋转之后的框（0–1）换算到裁切后的预览上；中心落在裁切框外面的返回 null（不显示）。 */
export function cropFaceBox(b: FaceBox, crop: CropBox | null): FaceBox | null {
	if (!crop) return b;
	const r = { x: (b.x - crop.x) / crop.w, y: (b.y - crop.y) / crop.h, w: b.w / crop.w, h: b.h / crop.h };
	const cx = r.x + r.w / 2;
	const cy = r.y + r.h / 2;
	return cx < 0 || cx > 1 || cy < 0 || cy > 1 ? null : r;
}

/** 条目的裁切框（没有裁切时为 null）。 */
export const assetCrop = (a: AssetDetail): CropBox | null => cropOf(a);

/** 显示尺寸：旋转、裁切之后（列表接口返回的也是这个尺寸）。尺寸未知时为 null。 */
export function displayDims(a: AssetDetail): [number, number] | null {
	if (!a.width || !a.height) return null;
	return croppedSize(a.width, a.height, cropOf(a));
}

/**
 * 编辑界面的底图：旋转之后、裁切之前、没有打码的整张图。都没有时就是预览；裁切或打码过的照片用处理时另存的底图（role = base）。
 * rotation 是这张图本身已经转过的角度。
 */
export function editSource(a: AssetDetail): { url: string; rotation: number; crop: CropBox | null; mask: string | null } {
	const crop = cropOf(a);
	const mask = a.mask ?? null;
	// 裁切或打码过的预览不是整张图：用处理时另存的底图（未裁切、未打码）
	const url = crop || mask ? fileUrl(a.id, "base", a.derived_rev) : fileUrl(a.id, "preview", a.derived_rev);
	return { url, rotation: a.rotation, crop, mask };
}
