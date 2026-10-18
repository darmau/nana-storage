/**
 * 把 exiftool -json -n 的输出整理成 assets 表的字段。
 *
 * 拍摄时间的来源优先级：
 *  1. DateTimeOriginal + OffsetTimeOriginal（照片，带时区）
 *  2. QuickTime CreationDate（Apple 视频，形如 "2024:05:01 12:34:56+08:00"）
 *  3. DateTimeOriginal 没有时区：本地日期以 EXIF 为准，换算 UTC 时用上传时浏览器的时区
 *  4. QuickTime CreateDate（按规范是 UTC）
 *  5. 文件修改时间（浏览器提供）
 */

import { TRAIT } from "@nana/shared";

export type Meta = Record<string, unknown>;

export interface ParsedMeta {
	takenAt: number | null;
	tzOffsetMin: number | null;
	localDay: string | null;
	localMonth: string | null;
	width: number | null;
	height: number | null;
	durationMs: number | null;
	lat: number | null;
	lon: number | null;
	camera: string | null;
	lens: string | null;
	contentIdentifier: string | null;
	/** Apple 连拍的分组 ID（MakerNote 的 BurstUUID） */
	burstUuid: string | null;
	/** 全景 / 长曝光 / 人像（RAW 由 process 按附件判断） */
	traits: number;
}

export interface Fallback {
	/** 文件修改时间（毫秒）。 */
	clientMtime: number | null;
	/** 上传时浏览器的时区偏移（分钟，东区为正）。 */
	clientTzOffsetMin: number | null;
}

const DATE_RE = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/;

interface LocalTime {
	y: number;
	mo: number;
	d: number;
	h: number;
	mi: number;
	s: number;
	ms: number;
	offsetMin: number | null;
}

function parseExifDate(value: unknown, subsec?: unknown): LocalTime | null {
	if (typeof value !== "string") return null;
	const m = DATE_RE.exec(value.trim());
	if (!m) return null;
	const [, y, mo, d, h, mi, s, frac, tz] = m;
	const t: LocalTime = {
		y: +y!, mo: +mo!, d: +d!, h: +h!, mi: +mi!, s: +s!,
		ms: fracToMs(frac ?? (subsec != null ? String(subsec) : undefined)),
		offsetMin: tz ? parseOffset(tz) : null,
	};
	if (t.y < 1900 || t.mo < 1 || t.mo > 12 || t.d < 1 || t.d > 31 || t.h > 23 || t.mi > 59 || t.s > 60) return null;
	return t;
}

const fracToMs = (frac?: string) => (frac && /^\d+$/.test(frac) ? Math.round(Number(`0.${frac}`) * 1000) : 0);

export function parseOffset(value: unknown): number | null {
	if (typeof value !== "string") return null;
	if (value === "Z") return 0;
	const m = /^([+-])(\d{2}):?(\d{2})$/.exec(value.trim());
	if (!m) return null;
	const min = +m[2]! * 60 + +m[3]!;
	if (min > 14 * 60) return null;
	return m[1] === "-" ? -min : min;
}

const pad = (n: number) => String(n).padStart(2, "0");
const localWallMs = (t: LocalTime) => Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s, t.ms);

function dayFromWall(wallMs: number) {
	const d = new Date(wallMs);
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function plausible(ms: number) {
	return ms > Date.UTC(1900, 0, 1) && ms < Date.now() + 2 * 24 * 3600_000;
}

const num = (v: unknown): number | null => {
	const n = typeof v === "string" ? Number(v) : v;
	return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function resolveTime(meta: Meta, fb: Fallback) {
	const out = (takenAt: number, tz: number | null, wall: number) =>
		plausible(takenAt) ? { takenAt, tzOffsetMin: tz, localDay: dayFromWall(wall) } : null;

	const dto = parseExifDate(meta.DateTimeOriginal, meta.SubSecTimeOriginal);
	const dtoOffset = parseOffset(meta.OffsetTimeOriginal) ?? parseOffset(meta.OffsetTime) ?? dto?.offsetMin ?? null;
	if (dto && dtoOffset !== null) {
		const wall = localWallMs(dto);
		const r = out(wall - dtoOffset * 60_000, dtoOffset, wall);
		if (r) return r;
	}

	const qtCreation = parseExifDate(meta.CreationDate);
	if (qtCreation && qtCreation.offsetMin !== null) {
		const wall = localWallMs(qtCreation);
		const r = out(wall - qtCreation.offsetMin * 60_000, qtCreation.offsetMin, wall);
		if (r) return r;
	}

	if (dto) {
		const wall = localWallMs(dto);
		const assumed = fb.clientTzOffsetMin ?? 0;
		const r = out(wall - assumed * 60_000, null, wall);
		if (r) return r;
	}

	const qtCreate = parseExifDate(meta.CreateDate);
	if (qtCreate && /^video\//.test(String(meta.MIMEType ?? ""))) {
		const utc = localWallMs(qtCreate); // QuickTime CreateDate 是 UTC
		const tz = fb.clientTzOffsetMin;
		const r = out(utc, null, utc + (tz ?? 0) * 60_000);
		if (r) return r;
	}

	if (fb.clientMtime && plausible(fb.clientMtime)) {
		const tz = fb.clientTzOffsetMin;
		return { takenAt: fb.clientMtime, tzOffsetMin: null, localDay: dayFromWall(fb.clientMtime + (tz ?? 0) * 60_000) };
	}
	return { takenAt: null, tzOffsetMin: null, localDay: null };
}

function resolveGps(meta: Meta): { lat: number | null; lon: number | null } {
	let lat = num(meta.GPSLatitude);
	let lon = num(meta.GPSLongitude);
	if ((lat === null || lon === null) && typeof meta.GPSCoordinates === "string") {
		const [a, b] = meta.GPSCoordinates.trim().split(/[\s,]+/).map(Number);
		lat = Number.isFinite(a) ? a! : null;
		lon = Number.isFinite(b) ? b! : null;
	}
	if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) {
		return { lat: null, lon: null };
	}
	return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
}

/** 原始尺寸（已按方向/旋转换算成显示方向）。 */
function resolveSize(meta: Meta): { width: number | null; height: number | null } {
	const w = num(meta.ImageWidth) ?? num(meta.ExifImageWidth);
	const h = num(meta.ImageHeight) ?? num(meta.ExifImageHeight);
	if (!w || !h) return { width: null, height: null };
	const orientation = num(meta.Orientation);
	const rotation = num(meta.Rotation);
	const swap = (orientation !== null && orientation >= 5 && orientation <= 8) || rotation === 90 || rotation === 270;
	return swap ? { width: h, height: w } : { width: w, height: h };
}

function resolveCamera(meta: Meta): string | null {
	const make = str(meta.Make);
	const model = str(meta.Model);
	if (!model) return make;
	if (!make || model.toLowerCase().startsWith(make.toLowerCase().split(" ")[0]!)) return model;
	return `${make} ${model}`;
}

/** 曝光时间达到这么多秒算长曝光。 */
const LONG_EXPOSURE_S = 1;
/** 长边 / 短边达到这个比例、并且是相机拍的（截图没有 Make/Model），算全景。 */
const PANORAMA_RATIO = 2;
/** 人像模式的痕迹：景深图、人像遮罩（Apple 辅助图像、Google GDepth、Pixel 的 SpecialTypeID）。 */
const PORTRAIT_KEY = /^(GDepth|Depth|PortraitEffectsMatte|AuxiliaryImageType$|SpecialTypeID$)/i;
const PORTRAIT_VALUE = /portrait|depth/i;

function resolveTraits(meta: Meta, width: number | null, height: number | null, camera: string | null): number {
	let t = 0;
	const projection = str(meta.ProjectionType);
	const panoViewer = meta.UsePanoramaViewer === true || meta.UsePanoramaViewer === "True";
	const ratio = width && height ? Math.max(width, height) / Math.min(width, height) : 0;
	if (projection || panoViewer || (camera && ratio >= PANORAMA_RATIO)) t |= TRAIT.panorama;

	const exposure = num(meta.ExposureTime);
	if (exposure !== null && exposure >= LONG_EXPOSURE_S) t |= TRAIT.longExposure;

	for (const [k, v] of Object.entries(meta)) {
		if (!PORTRAIT_KEY.test(k)) continue;
		// 带值的键（AuxiliaryImageType / SpecialTypeID）要看值，其余的键出现就算
		if (/AuxiliaryImageType|SpecialTypeID/i.test(k) ? PORTRAIT_VALUE.test(String(v)) : true) {
			t |= TRAIT.portrait;
			break;
		}
	}
	return t;
}

export function parseMeta(meta: Meta, fb: Fallback): ParsedMeta {
	const time = resolveTime(meta, fb);
	const duration = num(meta.Duration);
	const size = resolveSize(meta);
	const camera = resolveCamera(meta);
	const isVideo = /^video\//.test(String(meta.MIMEType ?? ""));
	return {
		...time,
		localMonth: time.localDay ? time.localDay.slice(0, 7) : null,
		...size,
		durationMs: duration !== null && duration > 0 ? Math.round(duration * 1000) : null,
		...resolveGps(meta),
		camera,
		lens: str(meta.LensModel) ?? str(meta.Lens),
		contentIdentifier: str(meta.ContentIdentifier),
		burstUuid: isVideo ? null : str(meta.BurstUUID),
		traits: isVideo ? 0 : resolveTraits(meta, size.width, size.height, camera),
	};
}
