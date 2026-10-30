import { useQueries, useQuery } from "@tanstack/react-query";
import { COMPOSE_MAX_EDGE, COMPOSE_MAX_PIXELS, COMPOSE_MIN_PIECE_PX, COMPOSE_SPLIT_MAX, COMPOSE_STITCH_MAX, type ComposeDirection } from "@nana/shared";
import { useLayoutEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { fmtNumber } from "../i18n/format";
import { t } from "../i18n";
import { previewUrl, thumbUrl } from "../timeline/types";
import { IconMinus, IconPlus } from "../ui/icons";
import { displayDims } from "../viewer/media";
import type { AssetDetail } from "../viewer/types";
import { Modal } from "./Modal";

/**
 * 拼接 / 切割的弹窗（服务端见 apps/worker/src/compose.ts）。只负责选参数，提交由调用方（SelectionBar 的 run）完成。
 * 尺寸都是照片现在看起来的样子（旋转、裁切之后，displayDims），和服务端的检查一致；缩略图和预览本来就是这个样子。
 */

const seg = (on: boolean) => `h-9 flex-1 rounded-full text-sm font-medium transition ${on ? "bg-card text-fg shadow-sm" : "text-muted hover:text-fg"}`;

/** 照片详情（和查看器共用缓存）。 */
const detailQuery = (id: string) => ({ queryKey: ["asset", id], queryFn: () => api<AssetDetail>(`/assets/${id}`), staleTime: 30_000 });

/** 不能拼接 / 切割的原因，没有问题时为 null。 */
function problem(a: AssetDetail): string | null {
	if (a.kind === "video") return t.compose.noVideo;
	if (a.mask) return t.compose.noMask;
	if (a.status !== "ready" || !displayDims(a)) return t.compose.notReady;
	return null;
}

function Direction({ value, onChange, labels }: { value: ComposeDirection; onChange: (d: ComposeDirection) => void; labels: [string, string] }) {
	return (
		<div className="mb-4 flex rounded-full bg-surface p-1" role="radiogroup">
			{(["vertical", "horizontal"] as const).map((d, i) => (
				<button key={d} role="radio" aria-checked={value === d} className={seg(value === d)} onClick={() => onChange(d)}>
					{labels[i]}
				</button>
			))}
		</div>
	);
}

function Footer({ note, error, label, disabled, onClose, onConfirm }: { note: string; error: string | null; label: string; disabled: boolean; onClose: () => void; onConfirm: () => void }) {
	return (
		<>
			{error ? <p className="mt-4 text-sm text-danger">{error}</p> : <p className="mt-4 text-sm text-muted">{note}</p>}
			<div className="mt-4 flex justify-end gap-2">
				<button className="btn" onClick={onClose}>
					{t.common.cancel}
				</button>
				<button className="btn-primary" disabled={disabled} onClick={onConfirm}>
					{label}
				</button>
			</div>
		</>
	);
}

/** 拼接预览里照片之间的空隙（只是界面上的分隔，拼出来的图没有空隙）。 */
const STITCH_GAP = 4;

/** 按 order 排列时 id 的起点（沿拼接方向，像素）。 */
const startOf = (order: string[], id: string, sizes: Map<string, number>) => {
	let pos = 0;
	for (const o of order) {
		if (o === id) break;
		const size = sizes.get(o);
		if (size !== undefined) pos += size + STITCH_GAP;
	}
	return pos;
};

/** 拼接：拖动照片调整顺序，选方向，预览拼好的样子。ids 是选中的顺序。 */
export function StitchDialog({ ids, onClose, onConfirm }: { ids: string[]; onClose: () => void; onConfirm: (ids: string[], direction: ComposeDirection) => void }) {
	const [order, setOrder] = useState(ids);
	const [direction, setDirection] = useState<ComposeDirection>("vertical");
	const details = useQueries({ queries: ids.slice(0, COMPOSE_STITCH_MAX).map(detailQuery) });
	const byId = new Map(details.flatMap((q) => (q.data ? [[q.data.id, q.data] as const] : [])));
	const failed = details.find((q) => q.error);
	const loading = details.some((q) => q.isPending);
	const vertical = direction === "vertical";

	const items = order.flatMap((id) => {
		const a = byId.get(id);
		const dims = a && displayDims(a);
		return a && dims ? [{ a, w: dims[0], h: dims[1] }] : [];
	});
	// 和服务端同样的算法：每张缩到最窄（纵向）/ 最矮（横向）那张
	const edge = items.length ? Math.min(...items.map((i) => (vertical ? i.w : i.h))) : 0;
	const lengths = items.map((i) => Math.max(1, Math.round(vertical ? (i.h * edge) / i.w : (i.w * edge) / i.h)));
	const total = lengths.reduce((a, b) => a + b, 0);
	const [W, H] = vertical ? [edge, total] : [total, edge];
	const tooLarge = W > COMPOSE_MAX_EDGE || H > COMPOSE_MAX_EDGE || W * H > COMPOSE_MAX_PIXELS;

	const over = ids.length > COMPOSE_STITCH_MAX;
	let error: string | null = null;
	if (over) error = t.compose.tooMany(COMPOSE_STITCH_MAX);
	else if (failed) error = t.common.loadFailed(errorText(failed.error));
	else if (!loading) error = [...byId.values()].map(problem).find(Boolean) ?? (tooLarge ? t.compose.tooLarge : null);

	// 拖动：按下时量好每张的长度，之后只算不量；拖着的那张跟手（transform），其余按新顺序排好，用 FLIP 动画让位
	const list = useRef<HTMLOListElement>(null);
	const drag = useRef<{ id: string; pointer: number; origin: number; sizes: Map<string, number> } | null>(null);
	const [held, setHeld] = useState<{ id: string; offset: number } | null>(null);
	const axis = (e: React.PointerEvent) => (vertical ? e.clientY : e.clientX);
	const tile = (id: string) => list.current?.querySelector<HTMLElement>(`[data-id="${id}"]`);

	const onDown = (e: React.PointerEvent, id: string) => {
		if (e.button !== 0 || !list.current) return;
		const sizes = new Map<string, number>();
		for (const el of list.current.querySelectorAll<HTMLElement>("[data-id]")) {
			const r = el.getBoundingClientRect();
			sizes.set(el.dataset.id!, vertical ? r.height : r.width);
		}
		drag.current = { id, pointer: axis(e), origin: startOf(order, id, sizes), sizes };
		list.current.setPointerCapture(e.pointerId);
		setHeld({ id, offset: 0 });
	};
	const onMove = (e: React.PointerEvent) => {
		const d = drag.current;
		if (!d) return;
		const at = d.origin + axis(e) - d.pointer;
		// 插到让它的起点离手指位置最近的地方
		const others = order.filter((o) => o !== d.id && d.sizes.has(o));
		let best = 0;
		let bestDist = Infinity;
		for (let p = 0, pos = 0; p <= others.length; p++) {
			if (Math.abs(pos - at) < bestDist) [best, bestDist] = [p, Math.abs(pos - at)];
			if (p < others.length) pos += d.sizes.get(others[p]!)! + STITCH_GAP;
		}
		// 没加载出来的（不在预览里）放到最后，反正有错误时不能提交
		const next = [...others.slice(0, best), d.id, ...others.slice(best), ...order.filter((o) => o !== d.id && !d.sizes.has(o))];
		if (next.some((o, i) => o !== order[i])) setOrder(next);
		setHeld({ id: d.id, offset: at - startOf(next, d.id, d.sizes) });
	};
	const onUp = () => {
		const d = drag.current;
		drag.current = null;
		if (!d || !held) return;
		// 松手时从当前位置滑回格子里
		const t0 = vertical ? `translateY(${held.offset}px)` : `translateX(${held.offset}px)`;
		if (!reducedMotion()) tile(d.id)?.animate([{ transform: t0 }, { transform: "none" }], { duration: 150, easing: "ease-out" });
		setHeld(null);
	};

	// FLIP：顺序变了之后，没被拖着的照片从原来的位置滑到新位置；换方向时不做
	const lastPos = useRef(new Map<string, number>());
	const lastDirection = useRef(direction);
	useLayoutEffect(() => {
		const animate = lastDirection.current === direction && !reducedMotion();
		lastDirection.current = direction;
		for (const el of list.current?.querySelectorAll<HTMLElement>("[data-id]") ?? []) {
			const id = el.dataset.id!;
			const r = el.getBoundingClientRect();
			// 拖着的那张记它在格子里的位置（去掉跟手的偏移），自己不做动画
			const dragging = id === drag.current?.id;
			const pos = (vertical ? r.top : r.left) - (dragging ? (held?.offset ?? 0) : 0);
			const prev = lastPos.current.get(id);
			lastPos.current.set(id, pos);
			if (!dragging && animate && prev !== undefined && prev !== pos) {
				const from = vertical ? `translateY(${prev - pos}px)` : `translateX(${prev - pos}px)`;
				el.animate([{ transform: from }, { transform: "none" }], { duration: 150, easing: "ease-out" });
			}
		}
	}, [order, direction, vertical]);

	const moveBy = (i: number, by: -1 | 1) =>
		setOrder((o) => {
			if (i + by < 0 || i + by >= o.length) return o;
			const next = [...o];
			[next[i], next[i + by]] = [next[i + by]!, next[i]!];
			return next;
		});

	return (
		<Modal title={t.compose.stitchTitle(ids.length)} onClose={onClose} wide>
			<Direction value={direction} onChange={setDirection} labels={[t.compose.vertical, t.compose.horizontal]} />
			<div className="flex justify-center rounded-xl bg-surface p-2">
				{loading || over || !items.length ? (
					<div className="skeleton h-60 w-full rounded-lg" />
				) : (
					// 整张预览放进 50dvh 以内，不滚动：一眼看到全部顺序，触屏上拖动也不会和滚动冲突
					<ol
						ref={list}
						className={`flex touch-none select-none ${vertical ? "flex-col" : ""}`}
						style={{ gap: STITCH_GAP, width: `min(100%, calc(50dvh * ${W} / ${H}))`, aspectRatio: `${W} / ${H}` }}
						onPointerMove={onMove}
						onPointerUp={onUp}
						onPointerCancel={onUp}
					>
						{items.map((it, i) => {
							const dragging = held?.id === it.a.id;
							return (
								<li
									key={it.a.id}
									data-id={it.a.id}
									tabIndex={0}
									aria-label={t.compose.position(i + 1, items.length)}
									className={`relative min-h-0 min-w-0 overflow-hidden rounded-[3px] outline-offset-2 ${dragging ? "z-10 cursor-grabbing shadow-xl ring-2 ring-accent" : "cursor-grab"}`}
									style={{ flex: `${lengths[i]} 1 0`, transform: dragging ? (vertical ? `translateY(${held.offset}px)` : `translateX(${held.offset}px)`) : undefined }}
									onPointerDown={(e) => onDown(e, it.a.id)}
									onKeyDown={(e) => {
										const by = e.key === (vertical ? "ArrowUp" : "ArrowLeft") ? -1 : e.key === (vertical ? "ArrowDown" : "ArrowRight") ? 1 : 0;
										if (!by) return;
										e.preventDefault();
										moveBy(i, by);
									}}
								>
									<img src={thumbUrl(it.a.id, it.a.derived_rev)} alt="" className="pointer-events-none h-full w-full object-cover" draggable={false} />
									<span className="pointer-events-none absolute left-1 top-1 rounded-full bg-black/55 px-1.5 text-xs font-semibold tabular-nums text-white">{i + 1}</span>
								</li>
							);
						})}
					</ol>
				)}
			</div>
			{!loading && items.length > 0 && (
				<p className="mt-2 text-xs tabular-nums text-muted">
					{t.compose.reorderHint} {t.compose.resultSize(fmtNumber(W), fmtNumber(H))}
				</p>
			)}
			<Footer
				note={t.compose.stitchNote}
				error={error}
				label={t.compose.stitch}
				disabled={loading || !!error || items.length < 2}
				onClose={onClose}
				onConfirm={() => onConfirm(order, direction)}
			/>
		</Modal>
	);
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 均分成 n 块的切线。 */
const evenCuts = (n: number) => Array.from({ length: n - 1 }, (_, i) => (i + 1) / n);

/** 切割：选方向和块数（先均分），切线可以拖动。 */
export function SplitDialog({ id, onClose, onConfirm }: { id: string; onClose: () => void; onConfirm: (direction: ComposeDirection, cuts: number[]) => void }) {
	const detail = useQuery(detailQuery(id));
	const a = detail.data;
	const dims = a ? displayDims(a) : null;
	// 默认沿长边切：长图横着切，宽图竖着切
	const [direction, setDirection] = useState<ComposeDirection | null>(null);
	const dir = direction ?? (dims && dims[0] > dims[1] ? "horizontal" : "vertical");
	const vertical = dir === "vertical";
	const [cuts, setCuts] = useState(() => evenCuts(2));
	const box = useRef<HTMLDivElement>(null);
	const dragging = useRef<number | null>(null);

	const length = dims ? (vertical ? dims[1] : dims[0]) : 0;
	// 每块至少 COMPOSE_MIN_PIECE_PX（和服务端一样按取整后的像素算），拖动时给相邻切线留出这么多
	const gap = length ? Math.max(0.005, (COMPOSE_MIN_PIECE_PX + 1) / length) : 0.01;
	const bounds = [0, ...cuts, 1];
	const px = bounds.map((b) => Math.round(b * length));
	const pieces = px.slice(1).map((p, i) => p - px[i]!);
	const tooSmall = pieces.some((p) => p < COMPOSE_MIN_PIECE_PX);

	const setCount = (n: number) => setCuts(evenCuts(Math.min(COMPOSE_SPLIT_MAX, Math.max(2, n))));
	const onMove = (e: React.PointerEvent) => {
		const i = dragging.current;
		const rect = box.current?.getBoundingClientRect();
		if (i === null || !rect) return;
		const f = vertical ? (e.clientY - rect.top) / rect.height : (e.clientX - rect.left) / rect.width;
		const lo = (i === 0 ? 0 : cuts[i - 1]!) + gap;
		const hi = (i === cuts.length - 1 ? 1 : cuts[i + 1]!) - gap;
		if (lo > hi) return;
		setCuts((c) => c.map((x, j) => (j === i ? Math.min(hi, Math.max(lo, f)) : x)));
	};

	let error: string | null = null;
	if (detail.error) error = t.common.loadFailed(errorText(detail.error));
	else if (a) error = problem(a) ?? (tooSmall ? t.compose.pieceTooSmall : null);

	return (
		<Modal title={t.compose.splitTitle} onClose={onClose} wide>
			<Direction
				value={dir}
				onChange={(d) => {
					setDirection(d);
					setCount(cuts.length + 1);
				}}
				labels={[t.compose.splitVertical, t.compose.splitHorizontal]}
			/>
			<div className="mb-4 flex items-center justify-between gap-3">
				<span className="text-sm font-medium">{t.compose.pieces}</span>
				<div className="flex items-center gap-1">
					<button className="btn !h-9 !w-9 !p-0" aria-label={t.compose.fewer} disabled={cuts.length <= 1} onClick={() => setCount(cuts.length)}>
						<IconMinus size={16} />
					</button>
					<span className="w-8 text-center text-sm font-semibold tabular-nums">{cuts.length + 1}</span>
					<button className="btn !h-9 !w-9 !p-0" aria-label={t.compose.more} disabled={cuts.length + 1 >= COMPOSE_SPLIT_MAX} onClick={() => setCount(cuts.length + 2)}>
						<IconPlus size={16} />
					</button>
				</div>
			</div>
			<div className="flex justify-center rounded-xl bg-surface p-2">
				{a && dims ? (
					<div
						ref={box}
						className="relative touch-none select-none"
						style={{ width: `min(100%, calc(50dvh * ${dims[0]} / ${dims[1]}))`, aspectRatio: `${dims[0]} / ${dims[1]}` }}
						onPointerMove={onMove}
						onPointerUp={() => (dragging.current = null)}
						onPointerCancel={() => (dragging.current = null)}
					>
						<img src={previewUrl(a.id, a.derived_rev)} alt="" className="h-full w-full" draggable={false} />
						{pieces.map((p, i) => (
							<span
								key={`n${i}`}
								className="pointer-events-none absolute rounded-full bg-black/55 px-2 text-xs font-semibold tabular-nums text-white"
								style={vertical ? { left: 6, top: `calc(${bounds[i]! * 100}% + 6px)` } : { top: 6, left: `calc(${bounds[i]! * 100}% + 6px)` }}
							>
								{i + 1} · {fmtNumber(p)}
							</span>
						))}
						{cuts.map((c, i) => (
							<div
								key={i}
								role="slider"
								aria-label={t.compose.cutLine(i + 1)}
								aria-valuenow={Math.round(c * 100)}
								aria-valuemin={0}
								aria-valuemax={100}
								tabIndex={0}
								className={`absolute flex items-center justify-center ${vertical ? "inset-x-0 h-6 -translate-y-1/2 cursor-row-resize" : "inset-y-0 w-6 -translate-x-1/2 cursor-col-resize"}`}
								style={vertical ? { top: `${c * 100}%` } : { left: `${c * 100}%` }}
								onPointerDown={(e) => {
									dragging.current = i;
									box.current?.setPointerCapture(e.pointerId);
								}}
								onKeyDown={(e) => {
									const step = e.key === (vertical ? "ArrowUp" : "ArrowLeft") ? -0.01 : e.key === (vertical ? "ArrowDown" : "ArrowRight") ? 0.01 : 0;
									if (!step) return;
									e.preventDefault();
									const lo = (i === 0 ? 0 : cuts[i - 1]!) + gap;
									const hi = (i === cuts.length - 1 ? 1 : cuts[i + 1]!) - gap;
									setCuts((cs) => cs.map((x, j) => (j === i ? Math.min(hi, Math.max(lo, x + step)) : x)));
								}}
							>
								<div className={`bg-accent shadow-[0_0_0_1px_rgb(0_0_0/0.4)] ${vertical ? "h-0.5 w-full" : "h-full w-0.5"}`} />
								<div className="absolute h-4 w-4 rounded-full border-2 border-white bg-accent shadow" />
							</div>
						))}
					</div>
				) : (
					<div className="skeleton h-60 w-full rounded-lg" />
				)}
			</div>
			<p className="mt-2 text-xs text-muted">{t.compose.dragHint}</p>
			<Footer
				note={t.compose.splitNote}
				error={error}
				label={t.compose.split}
				disabled={!a || !!error}
				onClose={onClose}
				onConfirm={() => onConfirm(dir, cuts.map((c) => Math.round(c * 1e6) / 1e6))}
			/>
		</Modal>
	);
}
