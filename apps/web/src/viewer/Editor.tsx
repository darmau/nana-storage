import {
	type CropBox,
	MASK_MAX_POINTS,
	MASK_MAX_STROKES,
	type MaskStroke,
	decodeMask,
	encodeMask,
	normalizeCrop,
	rotateBox,
	rotatePoint,
} from "@nana/shared";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { IconBlur, IconCrop, IconRotate, IconUndo } from "../ui/icons";
import { drawMaskOverlay, frostImage, simplify } from "./frost";

/**
 * 查看器的编辑模式：旋转、裁切和打码。只改缩略图和预览（服务端用 rotate 任务按新的角度、裁切框和打码重新生成，1 次 derive），原件不动。
 * 底图是旋转之后、裁切之前、没有打码的整张图（都没有时就是预览，否则用处理时另存的底图），旋转先用 CSS 转过去。
 * 裁切框是 0–1 的比例，相对于编辑界面里看到的方向（底图再转过 turn 度），和服务端存的一致。
 * 打码（毛玻璃，见 frost.ts）：涂抹的笔画存成相对于旋转之前的整张图的坐标（shared 的 MaskStroke），笔刷大小固定（屏幕上的大小），
 * 盖住的脸不再参与人物识别（服务端判断）。
 */

const FULL: CropBox = { x: 0, y: 0, w: 1, h: 1 };
/** 编辑时裁切框的最小边长（比例） */
const MIN = 0.05;
/** 打码笔刷的半径（屏幕上的 CSS 像素），不提供调整：放大、缩小窗口时相对于照片的大小跟着变 */
const BRUSH = 20;

export interface EditResult {
	/** 最终角度（底图本身的角度 + 编辑时转过的） */
	rotation: number;
	crop: CropBox | null;
	/** 打码（shared 的 encodeMask），null 表示没有打码 */
	mask: string | null;
	/** 保存之后、新图生成之前，查看器用它显示编辑结果 */
	preview: EditPreviewSpec;
}

export interface EditPreviewSpec {
	src: string;
	/** 底图的像素尺寸 */
	natural: [number, number];
	/** 在底图之上再转过的角度 */
	turn: number;
	crop: CropBox;
	/** 打码的覆盖层（底图的方向，盖住的地方是毛玻璃，其余透明），没有打码时为 null */
	overlay: HTMLCanvasElement | null;
}

const pointsOf = (strokes: MaskStroke[]) => strokes.reduce((n, s) => n + s.p.length / 2, 0);

export function Editor({
	source,
	onCancel,
	onSave,
}: {
	source: { url: string; rotation: number; crop: CropBox | null; mask: string | null };
	onCancel: () => void;
	onSave: (r: EditResult) => void;
}) {
	const [turn, setTurn] = useState(0);
	const [crop, setCrop] = useState<CropBox>(source.crop ?? FULL);
	const [strokes, setStrokes] = useState<MaskStroke[]>(() => decodeMask(source.mask) ?? []);
	const [mode, setMode] = useState<"crop" | "mask">("crop");
	const [full, setFull] = useState(false);
	const [natural, setNatural] = useState<[number, number] | null>(null);
	const [failed, setFailed] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const imgRef = useRef<HTMLImageElement | null>(null);
	const frostRef = useRef<HTMLCanvasElement | null>(null);
	/** 底图的毛玻璃版本：第一次用到时才算（约 1 百万像素，一次几十毫秒） */
	const getFrost = useCallback(() => (frostRef.current ??= imgRef.current ? frostImage(imgRef.current) : null), []);

	const rotate = () => {
		setTurn((v) => (v + 90) % 360);
		setCrop((c) => rotateBox(c, 90));
	};
	/** 还原：回到原件的方向，不裁切，不打码 */
	const reset = () => {
		setCrop(FULL);
		setTurn((360 - source.rotation) % 360);
		setStrokes([]);
	};
	const addStroke = (s: MaskStroke) => {
		if (strokes.length >= MASK_MAX_STROKES || pointsOf(strokes) + s.p.length / 2 > MASK_MAX_POINTS) return setFull(true);
		setStrokes([...strokes, s]);
	};
	const undo = () => {
		setFull(false);
		setStrokes((list) => list.slice(0, -1));
	};
	const mask = encodeMask(strokes);
	const changed =
		turn !== 0 || JSON.stringify(normalizeCrop(crop)) !== JSON.stringify(normalizeCrop(source.crop)) || mask !== (source.mask ?? null);
	const save = () => {
		if (!natural) return;
		if (!changed) return onCancel();
		const frosted = strokes.length ? getFrost() : null;
		let overlay: HTMLCanvasElement | null = null;
		if (frosted) {
			overlay = document.createElement("canvas");
			drawMaskOverlay(overlay, frosted, strokes, source.rotation);
		}
		onSave({
			rotation: (source.rotation + turn) % 360,
			crop: normalizeCrop(crop),
			mask,
			preview: { src: source.url, natural, turn, crop, overlay },
		});
	};

	useEffect(() => rootRef.current?.focus(), []);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const dialogs = document.querySelectorAll('[aria-modal="true"]');
			if (dialogs[dialogs.length - 1] !== rootRef.current) return;
			if (e.key === "Escape") onCancel();
			// 焦点在按钮上时 Enter 是点那个按钮
			else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) save();
			else if (e.key === "r" && mode === "crop") rotate();
			else if (e.key === "z" && (e.metaKey || e.ctrlKey) && mode === "mask") {
				e.preventDefault();
				undo();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	const button = "h-10 rounded-full px-4 text-sm font-semibold transition hover:bg-white/15";
	return (
		<div
			ref={rootRef}
			tabIndex={-1}
			role="dialog"
			aria-modal="true"
			aria-label={t.viewer.editTitle}
			className="theme-dark fixed inset-0 z-[60] flex flex-col bg-bg text-fg outline-none fade-in"
		>
			<div className="flex shrink-0 items-center justify-between gap-2 pl-[max(0.5rem,var(--safe-left))] pr-[max(0.5rem,var(--safe-right))] pt-[max(0.5rem,var(--safe-top))] pb-2">
				<button type="button" className={button} onClick={onCancel}>
					{t.common.cancel}
				</button>
				<h2 className="truncate text-[15px] font-semibold">{t.viewer.editTitle}</h2>
				<button
					type="button"
					className={`${button} bg-accent text-accent-fg hover:bg-accent hover:opacity-90 disabled:opacity-50`}
					disabled={!natural}
					onClick={save}
				>
					{t.viewer.editDone}
				</button>
			</div>

			<div className="relative min-h-0 flex-1 touch-none select-none overflow-hidden">
				{failed ? (
					<p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted">{t.viewer.editLoadFailed}</p>
				) : (
					<>
						{/* 先在屏幕外加载，拿到尺寸再排版 */}
						{!natural && (
							<img
								src={source.url}
								alt=""
								className="absolute opacity-0"
								onLoad={(e) => {
									imgRef.current = e.currentTarget;
									setNatural([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight]);
								}}
								onError={() => setFailed(true)}
							/>
						)}
						{natural &&
							(mode === "crop" ? (
								<CropStage src={source.url} natural={natural} turn={turn} crop={crop} onCrop={setCrop} strokes={strokes} rotation={source.rotation} getFrost={getFrost} />
							) : (
								<MaskStage
									src={source.url}
									natural={natural}
									turn={turn}
									crop={crop}
									rotation={source.rotation}
									strokes={strokes}
									getFrost={getFrost}
									onStroke={addStroke}
								/>
							))}
					</>
				)}
			</div>

			{mode === "mask" && (
				<p role="status" className={`shrink-0 px-4 pt-2 text-center text-xs ${full ? "text-danger" : "text-muted"}`}>
					{full ? t.viewer.maskFull : t.viewer.maskHint}
				</p>
			)}
			<div className="flex shrink-0 flex-wrap items-center justify-center gap-2 pb-[max(1rem,var(--safe-bottom))] pt-3">
				{mode === "crop" ? (
					<>
						<button type="button" className={`${button} flex items-center gap-2`} onClick={rotate}>
							<IconRotate size={20} />
							<span>{t.viewer.rotate}</span>
						</button>
						<button type="button" className={`${button} flex items-center gap-2`} onClick={() => setMode("mask")} disabled={!natural}>
							<IconBlur size={20} />
							<span>{t.viewer.editMask}</span>
						</button>
						<button type="button" className={button} onClick={reset} disabled={!natural}>
							{t.viewer.editReset}
						</button>
					</>
				) : (
					<>
						<button
							type="button"
							className={`${button} flex items-center gap-2`}
							onClick={() => {
								setFull(false);
								setMode("crop");
							}}
						>
							<IconCrop size={20} />
							<span>{t.viewer.editCrop}</span>
						</button>
						<button type="button" className={`${button} flex items-center gap-2`} onClick={undo} disabled={!strokes.length}>
							<IconUndo size={20} />
							<span>{t.viewer.maskUndo}</span>
						</button>
						<button
							type="button"
							className={button}
							onClick={() => {
								setFull(false);
								setStrokes([]);
							}}
							disabled={!strokes.length}
						>
							{t.viewer.maskClear}
						</button>
					</>
				)}
			</div>
		</div>
	);
}

/** 父元素的大小（随窗口变化更新）。 */
function useParentSize(ref: React.RefObject<HTMLElement | null>) {
	const [size, setSize] = useState<[number, number] | null>(null);
	useLayoutEffect(() => {
		const el = ref.current?.parentElement;
		if (!el) return;
		const measure = () => setSize([el.clientWidth, el.clientHeight]);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [ref]);
	return size;
}

/** 底图转过 turn 度之后的尺寸，按 box（宽、高）等比缩放放进去，不放大。 */
function fit(natural: [number, number], turn: number, box: [number, number], allowUpscale = false): [number, number] {
	const [w, h] = turn % 180 ? [natural[1], natural[0]] : natural;
	const s = Math.min(box[0] / w, box[1] / h, allowUpscale ? Infinity : 1);
	return [w * s, h * s];
}

/** 底图方向的元素按 turn 旋转后铺满 w×h 的方框（旋转之前的元素尺寸要对调）。 */
function turnedStyle(w: number, h: number, turn: number): React.CSSProperties {
	const sideways = turn % 180 !== 0;
	const iw = sideways ? h : w;
	const ih = sideways ? w : h;
	return { left: (w - iw) / 2, top: (h - ih) / 2, width: iw, height: ih, transform: turn ? `rotate(${turn}deg)` : undefined };
}

function TurnedImage({ src, w, h, turn }: { src: string; w: number; h: number; turn: number }) {
	return <img src={src} alt="" draggable={false} className="absolute max-w-none" style={turnedStyle(w, h, turn)} />;
}

/** 打码的覆盖层（底图方向），和 TurnedImage 叠在一起。draw 每次笔画变化时重画。 */
function MaskLayer({
	w,
	h,
	turn,
	rotation,
	strokes,
	getFrost,
	canvasRef,
}: {
	w: number;
	h: number;
	turn: number;
	rotation: number;
	strokes: MaskStroke[];
	getFrost: () => HTMLCanvasElement | null;
	canvasRef?: React.RefObject<HTMLCanvasElement | null>;
}) {
	const own = useRef<HTMLCanvasElement>(null);
	const ref = canvasRef ?? own;
	useLayoutEffect(() => {
		const c = ref.current;
		const f = strokes.length ? getFrost() : null;
		if (c && f) drawMaskOverlay(c, f, strokes, rotation);
		else if (c) c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
	}, [strokes, rotation, getFrost, ref]);
	return <canvas ref={ref} aria-hidden className="pointer-events-none absolute max-w-none" style={turnedStyle(w, h, turn)} />;
}

type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: Exclude<Handle, "move">[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** 按住拖动的那一边 / 角，或者整个框，移动 (dx, dy)（比例）。结果不超出图片、不小于 MIN。 */
export function dragCrop(c: CropBox, handle: Handle, dx: number, dy: number): CropBox {
	if (handle === "move") {
		return { ...c, x: Math.min(1 - c.w, Math.max(0, c.x + dx)), y: Math.min(1 - c.h, Math.max(0, c.y + dy)) };
	}
	let { x, y } = c;
	let right = c.x + c.w;
	let bottom = c.y + c.h;
	if (handle.includes("w")) x = Math.min(right - MIN, Math.max(0, x + dx));
	if (handle.includes("e")) right = Math.max(x + MIN, Math.min(1, right + dx));
	if (handle.includes("n")) y = Math.min(bottom - MIN, Math.max(0, y + dy));
	if (handle.includes("s")) bottom = Math.max(y + MIN, Math.min(1, bottom + dy));
	return { x, y, w: right - x, h: bottom - y };
}

/** 编辑区：整张底图 + 可拖动的裁切框（框外压暗，框内三分线）。 */
function CropStage({
	src,
	natural,
	turn,
	crop,
	onCrop,
	strokes,
	rotation,
	getFrost,
}: {
	src: string;
	natural: [number, number];
	turn: number;
	crop: CropBox;
	onCrop: (c: CropBox) => void;
	strokes: MaskStroke[];
	rotation: number;
	getFrost: () => HTMLCanvasElement | null;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const parent = useParentSize(ref);
	// 四周留出拖动把手的位置
	const pad = 24;
	const [w, h] = parent ? fit(natural, turn, [Math.max(1, parent[0] - pad * 2), Math.max(1, parent[1] - pad * 2)], true) : [0, 0];
	const drag = useRef<{ handle: Handle; x: number; y: number; start: CropBox } | null>(null);

	const down = (handle: Handle) => (e: React.PointerEvent) => {
		e.stopPropagation();
		e.currentTarget.setPointerCapture(e.pointerId);
		drag.current = { handle, x: e.clientX, y: e.clientY, start: crop };
	};
	const move = (e: React.PointerEvent) => {
		const d = drag.current;
		if (!d || !w || !h) return;
		onCrop(dragCrop(d.start, d.handle, (e.clientX - d.x) / w, (e.clientY - d.y) / h));
	};
	const up = () => {
		drag.current = null;
	};

	return (
		<div ref={ref} className="absolute inset-0 flex items-center justify-center">
			{parent && (
				<div className="relative" style={{ width: w, height: h }} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
					<div className="absolute inset-0 overflow-hidden">
						<TurnedImage src={src} w={w} h={h} turn={turn} />
						<MaskLayer w={w} h={h} turn={turn} rotation={rotation} strokes={strokes} getFrost={getFrost} />
					</div>
					<div
						className="absolute cursor-move border border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.6)]"
						style={{ left: crop.x * w, top: crop.y * h, width: crop.w * w, height: crop.h * h }}
						onPointerDown={down("move")}
					>
						{/* 三分线 */}
						<span className="pointer-events-none absolute inset-y-0 left-1/3 w-px bg-white/40" />
						<span className="pointer-events-none absolute inset-y-0 left-2/3 w-px bg-white/40" />
						<span className="pointer-events-none absolute inset-x-0 top-1/3 h-px bg-white/40" />
						<span className="pointer-events-none absolute inset-x-0 top-2/3 h-px bg-white/40" />
						{HANDLES.map((hd) => (
							<span
								key={hd}
								aria-hidden
								onPointerDown={down(hd)}
								className="absolute flex h-8 w-8 items-center justify-center"
								style={{
									left: hd.includes("w") ? -16 : hd.includes("e") ? undefined : "calc(50% - 16px)",
									right: hd.includes("e") ? -16 : undefined,
									top: hd.includes("n") ? -16 : hd.includes("s") ? undefined : "calc(50% - 16px)",
									bottom: hd.includes("s") ? -16 : undefined,
									cursor: `${hd === "n" || hd === "s" ? "ns" : hd === "e" || hd === "w" ? "ew" : hd === "ne" || hd === "sw" ? "nesw" : "nwse"}-resize`,
								}}
							>
								<span className={`block bg-white shadow ${hd.length === 2 ? "h-3.5 w-3.5 rounded-sm" : hd === "n" || hd === "s" ? "h-1.5 w-6 rounded-full" : "h-6 w-1.5 rounded-full"}`} />
							</span>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

/**
 * 打码：整张底图（裁切框外压暗，不能拖动），按住涂抹。笔画结束时简化（偏离不到笔刷半径 15% 的点去掉），
 * 换算成相对于旋转之前的整张图的坐标交给 onStroke。涂抹过程中直接重画覆盖层，不经过 React。
 */
function MaskStage({
	src,
	natural,
	turn,
	crop,
	rotation,
	strokes,
	getFrost,
	onStroke,
}: {
	src: string;
	natural: [number, number];
	turn: number;
	crop: CropBox;
	rotation: number;
	strokes: MaskStroke[];
	getFrost: () => HTMLCanvasElement | null;
	onStroke: (s: MaskStroke) => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const parent = useParentSize(ref);
	const pad = 24;
	const [w, h] = parent ? fit(natural, turn, [Math.max(1, parent[0] - pad * 2), Math.max(1, parent[1] - pad * 2)], true) : [0, 0];
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const cursorRef = useRef<HTMLDivElement>(null);
	const drawing = useRef<{ id: number; pts: [number, number][] } | null>(null);
	const frame = useRef(0);
	useEffect(() => () => cancelAnimationFrame(frame.current), []);

	const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
	/** 编辑界面里的像素位置 → 旋转之前的整张图上的比例 */
	const strokeOf = (pts: [number, number][]): MaskStroke => ({
		r: BRUSH / Math.max(w, h),
		p: pts.flatMap(([x, y]) => {
			const [bx, by] = rotatePoint(clamp01(x / w), clamp01(y / h), 360 - turn);
			return rotatePoint(bx, by, 360 - rotation);
		}),
	});
	const redraw = () => {
		cancelAnimationFrame(frame.current);
		frame.current = requestAnimationFrame(() => {
			const c = canvasRef.current;
			const f = getFrost();
			const d = drawing.current;
			if (c && f) drawMaskOverlay(c, f, d ? [...strokes, strokeOf(d.pts)] : strokes, rotation);
		});
	};
	const local = (e: React.PointerEvent): [number, number] => {
		const r = e.currentTarget.getBoundingClientRect();
		return [e.clientX - r.left, e.clientY - r.top];
	};
	const moveCursor = (x: number, y: number, show: boolean) => {
		const el = cursorRef.current;
		if (!el) return;
		el.style.transform = `translate(${x - BRUSH}px, ${y - BRUSH}px)`;
		el.style.opacity = show ? "1" : "0";
	};

	const down = (e: React.PointerEvent) => {
		if (drawing.current || (e.pointerType === "mouse" && e.button !== 0)) return;
		e.currentTarget.setPointerCapture(e.pointerId);
		drawing.current = { id: e.pointerId, pts: [local(e)] };
		redraw();
	};
	const move = (e: React.PointerEvent) => {
		const [x, y] = local(e);
		moveCursor(x, y, e.pointerType === "mouse");
		const d = drawing.current;
		if (!d || d.id !== e.pointerId) return;
		const [lx, ly] = d.pts[d.pts.length - 1]!;
		if (Math.hypot(x - lx, y - ly) < 3) return;
		d.pts.push([x, y]);
		redraw();
	};
	const up = (e: React.PointerEvent) => {
		const d = drawing.current;
		if (!d || d.id !== e.pointerId) return;
		drawing.current = null;
		onStroke(strokeOf(simplify(d.pts, BRUSH * 0.15)));
	};

	return (
		<div ref={ref} className="absolute inset-0 flex items-center justify-center">
			{parent && (
				<div
					className="relative cursor-none"
					style={{ width: w, height: h }}
					onPointerDown={down}
					onPointerMove={move}
					onPointerUp={up}
					onPointerCancel={up}
					onPointerLeave={(e) => moveCursor(...local(e), false)}
				>
					<div className="absolute inset-0 overflow-hidden">
						<TurnedImage src={src} w={w} h={h} turn={turn} />
						<MaskLayer w={w} h={h} turn={turn} rotation={rotation} strokes={strokes} getFrost={getFrost} canvasRef={canvasRef} />
					</div>
					{/* 裁切框外压暗：只是提示，打码对整张图生效 */}
					<div
						className="pointer-events-none absolute border border-white/40 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
						style={{ left: crop.x * w, top: crop.y * h, width: crop.w * w, height: crop.h * h }}
					/>
					<div
						ref={cursorRef}
						aria-hidden
						className="pointer-events-none absolute left-0 top-0 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
						style={{ width: BRUSH * 2, height: BRUSH * 2, opacity: 0 }}
					/>
				</div>
			)}
		</div>
	);
}

/**
 * 保存之后、服务端的新图生成之前，在查看器里直接显示编辑结果：底图转过 turn 度，只露出裁切框里的部分，按父元素大小缩放。
 */
export function EditPreview({ spec }: { spec: EditPreviewSpec }) {
	const ref = useRef<HTMLDivElement>(null);
	const parent = useParentSize(ref);
	const { natural, turn, crop } = spec;
	// 裁切后的尺寸（以底图像素计），再放进父元素
	const [fw, fh] = turn % 180 ? [natural[1], natural[0]] : natural;
	// 底图长边只有 2048，裁得小时要放大，才和之后生成的预览一样大
	const [cw, ch] = parent ? fit([fw * crop.w, fh * crop.h], 0, parent, true) : [0, 0];
	const W = cw / crop.w;
	const H = ch / crop.h;
	return (
		<div ref={ref} className="absolute inset-0 flex items-center justify-center">
			{parent && cw > 0 && (
				<div className="relative overflow-hidden" style={{ width: cw, height: ch }}>
					<div className="absolute" style={{ left: -crop.x * W, top: -crop.y * H, width: W, height: H }}>
						<TurnedImage src={spec.src} w={W} h={H} turn={turn} />
						{spec.overlay && <CanvasCopy source={spec.overlay} style={turnedStyle(W, H, turn)} />}
					</div>
					{/* 新图生成之前一直盖着，表示还在处理 */}
					<ProcessingVeil style={{ inset: 0 }} />
				</div>
			)}
		</div>
	);
}

/** 正在等后台生成新图的照片上盖的黑色遮罩（位置由调用方给出）。 */
export function ProcessingVeil({ style }: { style: React.CSSProperties }) {
	return <div role="img" aria-label={t.viewer.processingVeil} className="pointer-events-none absolute bg-black/55" style={style} />;
}

/** 把一个画好的 canvas 显示出来（复制一份像素，原来的 canvas 不挂到页面上）。 */
function CanvasCopy({ source, style }: { source: HTMLCanvasElement; style: React.CSSProperties }) {
	const ref = useRef<HTMLCanvasElement>(null);
	useLayoutEffect(() => {
		const c = ref.current;
		if (!c) return;
		c.width = source.width;
		c.height = source.height;
		c.getContext("2d")?.drawImage(source, 0, 0);
	}, [source]);
	return <canvas ref={ref} aria-hidden className="pointer-events-none absolute max-w-none" style={style} />;
}
