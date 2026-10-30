import type { CropBox } from "@nana/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { api, errorText } from "../api";
import { batch, invalidateLibrary } from "../library/actions";
import { markProcessing, unmarkProcessing, useProcessing } from "../library/processing";
import { t } from "../i18n";
import { formatTakenParts } from "../timeline/format";
import { KIND_LIVE, KIND_VIDEO, previewUrl, thumbUrl } from "../timeline/types";
import {
	IconChevronLeft,
	IconChevronRight,
	IconEdit,
	IconHd,
	IconHeart,
	IconInfo,
	IconLive,
	IconLiveOff,
	IconMinus,
	IconPlus,
	IconRestore,
	IconTrash,
} from "../ui/icons";
import { confirmDialog } from "../ui/confirm";
import { setLiveAutoplay, useLiveAutoplay } from "../ui/liveAutoplay";
import { useThemeColor } from "../ui/themeColor";
import { assetFacesQuery } from "../people/model";
import { EditPreview, type EditPreviewSpec, Editor, type EditResult, ProcessingVeil } from "./Editor";
import { InfoPanel } from "./InfoPanel";
import {
	assetCrop,
	cropFaceBox,
	displayDims,
	editSource,
	type FaceBox,
	type HdPlan,
	hdPlan,
	markHeicBroken,
	originalImageUrl,
	rotateFaceBox,
	videoSources,
} from "./media";
import type { Neighbor, ViewerNav } from "./sequence";
import type { AssetDetail } from "./types";

/**
 * 全屏查看器。
 *  - 预览（长边 3840，旧照片可能还是 2048）已经预加载 / 看过的直接显示；没有的先垫放大的模糊缩略图，预览到了再换。
 *    屏幕需要更多像素（高分屏全屏或放大）时再叠上原图。
 *  - “加载原图”：浏览器能解码的原件直接叠上去；解不了的（非 Safari 的 HEIC、RAW 等）请服务端按原图分辨率重新生成预览，
 *    生成好再叠上去。预览已经是原图分辨率时只提示“已经是最高清”。原图模式（顶栏开关）下停留一会儿就自动加载。
 *  - Live Photo：打开时播放一次（带声音，浏览器不允许时静音），之后悬停（桌面）或按住（触屏）再播放。顶栏开关可以关掉自动播放（这台设备的偏好），
 *    关掉后只在点 / 按住 Live 按钮时播放。
 *  - 视频：能解码 HEVC 的浏览器播原件，否则播 H.264 预览，出错就换下一个来源。
 *  - ←/→ 或左右滑动切换（跨月/跨页自动加载），并按上次切换的方向预加载前方两张，Esc 或下滑关闭，i 打开信息，f 收藏，e 编辑，双击放大。
 *  - 顶栏：左边返回、拍摄时间，Live 按钮在返回下面；右边加载原图、删除、收藏、编辑、信息。信息面板打开后切换照片也保持打开。
 *  - 编辑（Editor.tsx）：旋转、裁切和打码，只重新生成缩略图和预览，原件不动。保存后先用 CSS 显示编辑结果，等后台生成好新图再换上。
 *  - 单击照片隐藏全部界面只留照片，再单击恢复；等一下确认不是双击才切换。
 *  - 动效：打开时淡入并放大，关闭时淡出；滑动时照片跟手，松手后滑出，新照片从对应一侧滑入；下滑时背景随之变淡。
 *    系统要求减少动态效果时不做动画，也不等待。
 */
interface Props {
	id: string;
	nav: ViewerNav;
	onNavigate: (n: Neighbor) => void;
	onClose: () => void;
	/** 回收站里显示“恢复”，其他地方显示“收藏 / 删除” */
	context?: "library" | "trash";
	/** 从人物页打开时：照片上圈出这个人物的脸 */
	personId?: string;
}

const CLOSE_MS = 170;
const SWIPE_OUT_MS = 160;
/** 正在预加载的图片：留着引用免得请求中途被回收，同一个地址不重复请求 */
const preloading = new Map<string, HTMLImageElement>();
/**
 * 已经下载并解码过的预览地址。切换到这些照片时直接显示预览，不再先闪一下模糊的缩略图。
 * 最近几张的 Image 对象留着引用，浏览器更可能保留解码好的位图；只留几张，3840 的预览解码后每张几十 MB。
 */
const ready = new Map<string, HTMLImageElement | null>();
const READY_MAX = 200;
const DECODED_KEEP = 4;
function markReady(url: string, img: HTMLImageElement | null) {
	ready.delete(url);
	ready.set(url, img);
	let held = 0;
	for (const [u, el] of [...ready].reverse()) {
		if (el && ++held > DECODED_KEEP) ready.set(u, null);
	}
	while (ready.size > READY_MAX) ready.delete(ready.keys().next().value!);
}
function preloadImage(url: string) {
	if (preloading.has(url) || ready.has(url)) return;
	const img = new Image();
	img.decoding = "async";
	preloading.set(url, img);
	img.src = url;
	// decode() 等下载完再在后台解码，切换过去时不用在主线程上现解一张大图
	img.decode().then(
		() => {
			preloading.delete(url);
			markReady(url, img);
		},
		() => preloading.delete(url),
	);
}
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Viewer({ id, nav, onNavigate, onClose, context = "library", personId }: Props) {
	const qc = useQueryClient();
	const item = nav.item;
	const detail = useQuery({ queryKey: ["asset", id], queryFn: () => api<AssetDetail>(`/assets/${id}`) });
	const [showInfo, setShowInfo] = useState(false);
	// 沉浸模式：隐藏所有按钮和信息面板，切换照片时保持
	const [immersive, setImmersive] = useState(false);
	const chrome = `transition-opacity duration-200 ${immersive ? "pointer-events-none opacity-0" : ""}`;
	// 和 .theme-dark 的 --bg 一致
	useThemeColor("#0e0f11");
	const [zoom, setZoom] = useState<{ scale: number; x: number; y: number }>({ scale: 1, x: 0, y: 0 });

	const kind = item?.[3] ?? (detail.data?.kind === "video" ? KIND_VIDEO : detail.data?.kind === "live" ? KIND_LIVE : 0);
	const rev = detail.data?.derived_rev ?? item?.[7] ?? 0;

	// 关闭：先播淡出动画再真正关闭（浏览器后退直接卸载，不走这里）
	const rootRef = useRef<HTMLDivElement>(null);
	const [closing, setClosing] = useState(false);
	const closingRef = useRef(false);
	const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
	const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			timers.current.forEach(clearTimeout);
			if (tapTimer.current) clearTimeout(tapTimer.current);
		},
		[],
	);
	const later = (fn: () => void, ms: number) => {
		if (reduceMotion()) return fn();
		timers.current.push(setTimeout(fn, ms));
	};
	const requestClose = useCallback(() => {
		if (closingRef.current) return;
		closingRef.current = true;
		setClosing(true);
		later(onClose, CLOSE_MS);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onClose]);

	// 切换动画：enter 记下新照片从哪边进来（渲染新 id 时读取），swipe 是手指拖动 / 滑出的位移
	const enter = useRef<{ dir: -1 | 0 | 1; from: string }>({ dir: 0, from: "0" });
	const [swipe, setSwipe] = useState({ x: 0, y: 0, settle: false });
	// 换了照片就在绘制前复位，滑出去的旧照片不会闪回中间
	useLayoutEffect(() => setSwipe((s) => (s.x || s.y || s.settle ? { x: 0, y: 0, settle: false } : s)), [id]);
	// 上一次切换的方向，决定往哪边多预加载
	const heading = useRef<-1 | 1>(1);
	const navigate = useCallback(
		(n: Neighbor, dir: -1 | 1, from: string) => {
			if (closingRef.current) return;
			enter.current = { dir, from };
			heading.current = dir;
			onNavigate(n);
		},
		[onNavigate],
	);

	const go = useCallback(
		async (dir: -1 | 1) => {
			const n = await nav.neighbor(dir);
			if (n) navigate(n, dir, `${dir * 8}%`);
		},
		[nav, navigate],
	);
	/** 滑动松手后：有下一张就把当前这张滑出去再切换，到头了就弹回原位 */
	const swipeTo = async (dir: -1 | 1) => {
		const n = await nav.neighbor(dir);
		if (!n) return setSwipe({ x: 0, y: 0, settle: true });
		setSwipe({ x: -dir * window.innerWidth, y: 0, settle: true });
		later(() => navigate(n, dir, `${dir * 30}%`), SWIPE_OUT_MS);
	};

	// 预加载：按上一次切换的方向加载前方两张的预览，反方向只加载一张（刚打开时当作往后看）
	useEffect(() => {
		let cancelled = false;
		const dir = heading.current;
		for (const [d, steps] of [[dir, 1], [dir, 2], [-dir as -1 | 1, 1]] as const) {
			void nav.neighbor(d, steps).then((n) => {
				if (!cancelled && n) preloadImage(previewUrl(n.id, n.item[7]));
			});
		}
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [id]);

	const favorite = detail.data ? detail.data.favorite === 1 : item?.[6] === 1;
	const [editing, setEditing] = useState(false);
	const edit = useEditSave(id, detail.data, () => invalidateLibrary(qc));
	const processing = useProcessing(id);
	// 预览图本身的角度和裁切（有任务在跑时预览可能还是旧的，和详情对不上，原图、人脸圈都先不叠）
	const settled = detail.data && detail.data.id === id && !detail.data.jobs_active && !edit.pending ? detail.data : null;
	const crop = settled ? assetCrop(settled) : null;
	// 信息面板：切换照片时新详情还没读到，先留着上一张的，面板不会关掉再打开
	const lastDetail = useRef<AssetDetail | undefined>(undefined);
	if (detail.data) lastDetail.current = detail.data;
	const panelAsset = detail.data ?? lastDetail.current;
	// 人物页打开的照片圈出这个人的脸（和信息面板共用同一个查询，每张照片请求一次）
	const faces = useQuery({ ...assetFacesQuery(id), enabled: !!personId && kind !== KIND_VIDEO });
	const personFaces = personId ? faces.data?.items.filter((f) => f.person?.id === personId).map((f) => f.box) : undefined;
	const liveAutoplay = useLiveAutoplay();
	// 点顶栏的 Live 按钮：每点一次加一，Still 收到就播放一次
	const [livePlay, setLivePlay] = useState(0);
	const hd = useHd(id, context === "trash" ? undefined : detail.data, () => invalidateLibrary(qc));
	// 顶部的短暂提示（“已经是最高清”之类）
	const [notice, setNotice] = useState<{ text: string; key: number } | null>(null);
	useEffect(() => {
		if (!notice) return;
		const t = setTimeout(() => setNotice(null), 1800);
		return () => clearTimeout(t);
	}, [notice]);
	const say = (text: string) => setNotice({ text, key: Date.now() });
	useEffect(() => setNotice(null), [id]);
	// 窄屏上按钮只有图标，失败要明说
	useEffect(() => {
		if (hd.state === "failed") say(t.viewer.hdFailed);
	}, [hd.state]);
	const [acting, setActing] = useState(false);
	const act = async (action: "favorite" | "trash" | "restore") => {
		if (acting) return;
		if (
			action === "trash" &&
			!(await confirmDialog({
				title: t.actions.trashTitle(1),
				message: t.actions.trashMessage,
				confirmLabel: t.actions.delete,
				danger: true,
			}))
		)
			return;
		setActing(true);
		try {
			// 删除/恢复之后，当前这张就不在列表里了：先找好下一张
			const after = action === "favorite" ? null : await nav.neighbor(1);
			const before = action === "favorite" || after ? null : await nav.neighbor(-1);
			await batch(qc, [id], action === "favorite" ? { action, value: !favorite } : { action });
			if (action === "favorite") return;
			if (after) navigate(after, 1, "8%");
			else if (before) navigate(before, -1, "-8%");
			else requestClose();
		} finally {
			setActing(false);
		}
	};

	useEffect(() => setZoom({ scale: 1, x: 0, y: 0 }), [id]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			// 上面还有弹窗（确认框、选位置）或者正在输入时不响应
			const dialogs = document.querySelectorAll('[aria-modal="true"]');
			if (dialogs[dialogs.length - 1] !== rootRef.current) return;
			if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable]")) return;
			if (e.key === "Escape") requestClose();
			else if (e.key === "ArrowLeft") void go(-1);
			else if (e.key === "ArrowRight") void go(1);
			else if (e.key === "i") {
				setShowInfo((v) => immersive || !v);
				setImmersive(false);
			}
			else if (e.key === "f" && context === "library") void act("favorite");
			else if (e.key === "e") startEdit();
		};
		window.addEventListener("keydown", onKey);
		const prevOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			window.removeEventListener("keydown", onKey);
			document.body.style.overflow = prevOverflow;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [go, requestClose, favorite, context, immersive, detail.data, edit.pending]);

	// 滑动：照片跟手，左右切换，下滑关闭；放大时拖动平移。移动超过 8px 才确定方向，之后只沿这个方向动
	const drag = useRef<{ x: number; y: number; zx: number; zy: number; t: number; axis: "x" | "y" | null } | null>(null);
	/** 按钮、工具栏这些控件上的操作不算点在照片上 */
	const onControl = (e: React.SyntheticEvent) => !!(e.target as HTMLElement).closest("button, a, video, aside, [data-chrome]");
	const onPointerDown = (e: React.PointerEvent) => {
		if (closingRef.current || onControl(e)) return;
		drag.current = { x: e.clientX, y: e.clientY, zx: zoom.x, zy: zoom.y, t: e.timeStamp, axis: null };
	};
	/** 单击切换沉浸模式。250ms 内的第二次点击是双击（放大），取消切换 */
	const onTap = () => {
		if (tapTimer.current) {
			clearTimeout(tapTimer.current);
			tapTimer.current = null;
			return;
		}
		tapTimer.current = setTimeout(() => {
			tapTimer.current = null;
			setImmersive((v) => !v);
		}, 250);
	};
	const onPointerMove = (e: React.PointerEvent) => {
		const d = drag.current;
		if (!d) return;
		const dx = e.clientX - d.x;
		const dy = e.clientY - d.y;
		if (zoom.scale !== 1) return setZoom((z) => ({ ...z, x: d.zx + dx, y: d.zy + dy }));
		if (!d.axis) {
			if (Math.hypot(dx, dy) < 8) return;
			d.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
			e.currentTarget.setPointerCapture(e.pointerId);
		}
		setSwipe({ x: d.axis === "x" ? dx : 0, y: d.axis === "y" ? Math.max(0, dy) : 0, settle: false });
	};
	const onPointerUp = (e: React.PointerEvent) => {
		const d = drag.current;
		drag.current = null;
		if (!d) return;
		const dx = e.clientX - d.x;
		const dy = e.clientY - d.y;
		// 没怎么移动、也不是长按（Live Photo 按住播放）才算单击
		if (!d.axis && Math.hypot(dx, dy) < 8 && e.timeStamp - d.t < 500) return onTap();
		if (zoom.scale !== 1 || !d.axis) return;
		if (d.axis === "x" && Math.abs(dx) > 60) void swipeTo(dx < 0 ? 1 : -1);
		else if (d.axis === "y" && dy > 120) {
			setSwipe({ x: 0, y: dy + window.innerHeight * 0.15, settle: true });
			requestClose();
		} else setSwipe({ x: 0, y: 0, settle: true });
	};
	const onPointerCancel = () => {
		drag.current = null;
		setSwipe({ x: 0, y: 0, settle: true });
	};
	const onDoubleClick = (e: React.MouseEvent) => {
		// 快速连点“下一张”或缩放按钮也会冒泡出 dblclick，不能当成双击放大
		if (kind === KIND_VIDEO || onControl(e)) return;
		if (zoom.scale > 1) return setZoom({ scale: 1, x: 0, y: 0 });
		const rect = e.currentTarget.getBoundingClientRect();
		const cx = e.clientX - rect.left - rect.width / 2;
		const cy = e.clientY - rect.top - rect.height / 2;
		setZoom({ scale: 2.5, x: -cx * 1.5, y: -cy * 1.5 });
	};

	// 缩放按钮：以当前画面中心为准，按档位放大缩小
	const ZOOM_STEPS = [1, 1.5, 2, 3, 4];
	const zoomBy = (dir: -1 | 1) =>
		setZoom((z) => {
			const i = ZOOM_STEPS.findIndex((s) => s >= z.scale - 0.01);
			const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (i === -1 ? ZOOM_STEPS.length - 1 : i) + dir))]!;
			if (next === 1) return { scale: 1, x: 0, y: 0 };
			return { scale: next, x: (z.x * next) / z.scale, y: (z.y * next) / z.scale };
		});
	const taken = detail.data ? formatTakenParts(detail.data.taken_at, detail.data.tz_offset_min) : null;
	const dims: [number, number] | null = item?.[1] && item[2] ? [item[1], item[2]] : detail.data ? displayDims(detail.data) : null;
	const canEdit = context !== "trash" && kind !== KIND_VIDEO && !!detail.data && detail.data.id === id;
	function startEdit() {
		if (!canEdit) return;
		// 后台还在生成上一次编辑（或加载原图）的结果时，底图可能还是旧的
		if (detail.data!.jobs_active || edit.pending) return say(t.viewer.editBusy);
		setZoom({ scale: 1, x: 0, y: 0 });
		setEditing(true);
	}

	return (
		<div
			ref={rootRef}
			className={`theme-dark fixed inset-0 z-50 flex bg-bg text-fg ${closing ? "pointer-events-none fade-out" : "fade-in"}`}
			// 下滑关闭时背景跟着变淡
			style={swipe.y ? { backgroundColor: `color-mix(in srgb, var(--bg) ${Math.round(100 - Math.min(swipe.y / 4, 70))}%, transparent)` } : undefined}
			role="dialog"
			aria-modal="true"
			aria-label={t.viewer.dialog}
		>
			<div
				className="relative flex-1 touch-none select-none overflow-hidden"
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerCancel}
				onDoubleClick={onDoubleClick}
			>
				<div className={`absolute inset-0 ${closing ? "viewer-zoom-out" : "viewer-zoom-in"}`}>
					<div
						className="absolute inset-0"
						style={{
							transform: swipe.x || swipe.y ? `translate(${swipe.x}px, ${swipe.y}px) scale(${1 - Math.min(swipe.y / 2000, 0.2)})` : undefined,
							transition: swipe.settle ? `transform ${SWIPE_OUT_MS}ms ease-out` : undefined,
						}}
					>
						<div
							key={id}
							className={`absolute inset-0 ${enter.current.dir ? "viewer-slide-in" : ""}`}
							style={{ "--enter-x": enter.current.from } as React.CSSProperties}
						>
							<div
								className={`absolute inset-0 flex items-center justify-center transition-transform duration-150 ${immersive ? "" : "sm:inset-x-20 sm:bottom-6 sm:top-16"}`}
								style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }}
							>
								{kind === KIND_VIDEO ? (
									detail.data ? (
										<VideoPlayer key={id} asset={detail.data} poster={previewUrl(id, rev)} />
									) : (
										<img src={previewUrl(id, rev)} alt="" className="max-h-full max-w-full object-contain" />
									)
								) : edit.pending ? (
									<div className="relative flex h-full w-full items-center justify-center">
										<EditPreview spec={edit.pending} />
									</div>
								) : (
									<div className="flex h-full w-full items-center justify-center">
										<Still
											key={`${id}-${rev}-${edit.version}`}
											id={id}
											rev={rev}
											bust={edit.version}
											dims={dims}
											live={kind === KIND_LIVE ? detail.data : undefined}
											autoplay={liveAutoplay}
											playNonce={livePlay}
											original={settled ? originalImageUrl(settled) : null}
											rotation={settled?.rotation ?? 0}
											crop={crop}
											forceOriginal={hd.force}
											upgraded={hd.upgraded}
											onOriginal={hd.report}
											scale={zoom.scale}
											faces={!immersive && settled && personFaces?.length ? { boxes: personFaces, rotation: settled.rotation, crop } : null}
											processing={processing}
										/>
									</div>
								)}
							</div>
						</div>
					</div>
				</div>

				<div
					data-chrome
					inert={immersive}
					className={`absolute inset-x-0 top-0 flex items-start gap-1 ${chrome} bg-gradient-to-b from-black/55 to-transparent pb-6 pl-[max(0.5rem,var(--safe-left))] pr-[max(0.5rem,var(--safe-right))] pt-[max(0.5rem,var(--safe-top))] sm:bg-none sm:pb-2`}
				>
					<div className="mr-auto flex min-w-0 flex-col items-start">
						<div className="flex min-w-0 max-w-full items-center">
							<IconButton label={t.common.close} onClick={requestClose}>
								<IconChevronLeft size={24} />
							</IconButton>
							<div className="min-w-0 pl-1 leading-tight">
								{taken && (
									<>
										<div className="truncate text-[15px] font-semibold">{taken.date}</div>
										<div className="truncate text-xs text-muted">{taken.time}</div>
									</>
								)}
							</div>
						</div>
						{kind === KIND_LIVE && (
							<LiveButton
								autoplay={liveAutoplay}
								// 同步渲染：Still 的 useLayoutEffect 在这次点击里调用 play()，浏览器才允许有声播放（iOS Safari 只认点击当时）
								onPlay={() => flushSync(() => setLivePlay((n) => n + 1))}
								onToggle={() => {
									setLiveAutoplay(!liveAutoplay);
									say(liveAutoplay ? t.viewer.liveAutoplayTurnedOff : t.viewer.liveAutoplayTurnedOn);
								}}
							/>
						)}
					</div>
					<div className="flex shrink-0 items-center gap-1">
						{hd.plan && !edit.pending && (
							<HdButton
								plan={hd.plan}
								state={hd.state}
								onClick={() => {
									if (hd.state === "shown") say(t.viewer.hdShown);
									else if (hd.plan?.kind === "best") say(t.viewer.hdBestLabel);
									else void hd.load();
								}}
							/>
						)}
						{context === "trash" ? (
							<IconButton label={t.actions.restore} onClick={() => void act("restore")}>
								<IconRestore />
							</IconButton>
						) : (
							<>
								<IconButton label={t.actions.delete} onClick={() => void act("trash")}>
									<IconTrash />
								</IconButton>
								<IconButton label={favorite ? t.actions.unfavorite : t.actions.favorite} onClick={() => void act("favorite")} pressed={favorite}>
									<IconHeart filled={favorite} className={favorite ? "text-[#ff8a80]" : ""} />
								</IconButton>
								{kind !== KIND_VIDEO && (
									<IconButton label={t.viewer.edit} onClick={startEdit} disabled={!canEdit}>
										<IconEdit />
									</IconButton>
								)}
							</>
						)}
						<IconButton label={t.viewer.info} onClick={() => setShowInfo((v) => !v)} pressed={showInfo}>
							<IconInfo />
						</IconButton>
					</div>
				</div>

				<IconButton
					label={t.viewer.prev}
					inert={immersive}
					className={`absolute left-4 top-1/2 hidden !h-14 !w-14 -translate-y-1/2 bg-white/10 sm:flex ${chrome}`}
					onClick={() => void go(-1)}>
					<IconChevronLeft size={28} />
				</IconButton>
				<IconButton
					label={t.viewer.next}
					inert={immersive}
					className={`absolute right-4 top-1/2 hidden !h-14 !w-14 -translate-y-1/2 bg-white/10 sm:flex ${chrome}`}
					onClick={() => void go(1)}>
					<IconChevronRight size={28} />
				</IconButton>

				{kind !== KIND_VIDEO && (
					<div
						data-chrome
						inert={immersive}
						className={`absolute bottom-[max(1rem,var(--safe-bottom))] left-[max(1rem,var(--safe-left))] hidden items-center gap-0.5 rounded-full bg-surface/90 p-0.5 sm:flex ${chrome}`}
					>
						<IconButton label={t.viewer.zoomOut} className="!h-9 !w-9" onClick={() => zoomBy(-1)}>
							<IconMinus size={18} />
						</IconButton>
						<button
							type="button"
							title={t.viewer.reset}
							aria-label={t.viewer.resetLabel}
							onClick={() => setZoom({ scale: 1, x: 0, y: 0 })}
							className="h-9 min-w-14 rounded-full px-2 text-xs font-semibold tabular-nums hover:bg-white/10"
						>
							{Math.round(zoom.scale * 100)}%
						</button>
						<IconButton label={t.viewer.zoomIn} className="!h-9 !w-9" onClick={() => zoomBy(1)}>
							<IconPlus size={18} />
						</IconButton>
					</div>
				)}
				<p className={`pointer-events-none absolute bottom-6 right-6 hidden text-xs text-muted lg:block ${chrome}`}>
					{t.viewer.shortcuts}
				</p>
				{notice && (
					<p
						key={notice.key}
						role="status"
						className="pointer-events-none absolute left-1/2 top-[calc(max(0.5rem,var(--safe-top))+3.5rem)] -translate-x-1/2 whitespace-nowrap rounded-full bg-black/65 px-3.5 py-1.5 text-xs font-medium text-white fade-in"
					>
						{notice.text}
					</p>
				)}
				{detail.error && <p className="absolute bottom-16 left-4 text-sm text-danger">{t.common.loadFailed(errorText(detail.error))}</p>}
			</div>
			{showInfo && !immersive && panelAsset && <InfoPanel asset={panelAsset} onClose={() => setShowInfo(false)} onMoved={requestClose} />}
			{editing && detail.data && (
				<Editor
					source={editSource(detail.data)}
					onCancel={() => setEditing(false)}
					onSave={(r) => {
						setEditing(false);
						edit.save(r).catch((e: unknown) => say(t.viewer.editFailed(errorText(e))));
					}}
				/>
			)}
		</div>
	);
}

/** 长按（或右键）这么久切换 Live Photo 自动播放 */
const LIVE_HOLD_MS = 500;

/** 顶栏的 Live 按钮：点一下播放一次，长按 / 右键切换自动播放。图标表示自动播放是否打开。 */
function LiveButton({ autoplay, onPlay, onToggle }: { autoplay: boolean; onPlay: () => void; onToggle: () => void }) {
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const held = useRef(false);
	const cancel = () => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
	};
	useEffect(() => cancel, []);
	return (
		<button
			type="button"
			aria-label={t.viewer.playLive}
			title={`${t.viewer.playLive}\n${t.viewer.liveHoldHint}`}
			onPointerDown={() => {
				held.current = false;
				cancel();
				timer.current = setTimeout(() => {
					held.current = true;
					timer.current = null;
					onToggle();
				}, LIVE_HOLD_MS);
			}}
			onPointerUp={cancel}
			onPointerLeave={cancel}
			onPointerCancel={cancel}
			onContextMenu={(e) => {
				e.preventDefault();
				// 触屏长按也会触发 contextmenu：已经由计时器切换过就不再切换
				if (held.current) return;
				cancel();
				held.current = true;
				onToggle();
			}}
			onClick={() => {
				if (held.current) {
					held.current = false;
					return;
				}
				onPlay();
			}}
			className="flex h-11 w-11 shrink-0 select-none items-center justify-center rounded-full text-fg transition [-webkit-touch-callout:none] hover:bg-white/15"
		>
			{autoplay ? <IconLive /> : <IconLiveOff />}
		</button>
	);
}

function IconButton({
	label,
	onClick,
	className = "",
	pressed,
	inert,
	disabled,
	children,
}: {
	label: string;
	onClick: () => void;
	className?: string;
	pressed?: boolean;
	inert?: boolean;
	disabled?: boolean;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			aria-pressed={pressed}
			inert={inert}
			disabled={disabled}
			title={label}
			onClick={onClick}
			className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg transition hover:bg-white/15 disabled:opacity-40 disabled:hover:bg-transparent ${pressed ? "bg-white/15" : ""} ${className}`}
		>
			{children}
		</button>
	);
}

/**
 * 照片 / Live Photo。预览已经下载过（预加载或者看过）就直接显示；否则先垫一张放大到同样大小的模糊缩略图，
 * 预览到了再淡出。需要时再叠上原图；Live 部分叠在最上面播放。
 */
function Still({
	id,
	rev,
	dims,
	live,
	autoplay = true,
	playNonce = 0,
	bust = 0,
	original,
	rotation,
	crop,
	forceOriginal = false,
	upgraded = null,
	onOriginal,
	scale,
	faces = null,
	processing = false,
}: {
	id: string;
	rev: number;
	/** 照片的宽高，让缩略图占住和预览相同的位置，换成预览时画面不跳 */
	dims: [number, number] | null;
	live?: AssetDetail;
	/** Live Photo 打开时和悬停时自动播放；关掉后只由顶栏的 Live 按钮播放 */
	autoplay?: boolean;
	/** 顶栏 Live 按钮的点击计数：挂载之后每变一次播放一次 */
	playNonce?: number;
	bust?: number;
	original: { url: string; heic: boolean } | null;
	/** 预览图本身转过的角度和裁切框：原图、Live 视频（都是没转过、没裁过的）按它摆到和预览重合 */
	rotation: number;
	crop: CropBox | null;
	/** 点了“加载原图”：不等放大，马上加载 */
	forceOriginal?: boolean;
	/** 服务端刚生成好的全尺寸预览（已经转好角度），盖在旧预览上 */
	upgraded?: string | null;
	/** 原图（或全尺寸预览）显示出来 / 加载失败 */
	onOriginal?: (ok: boolean) => void;
	scale: number;
	/** 要圈出来的脸：框按用户旋转之前的照片，rotation / crop 是预览图本身转过的角度和裁切框 */
	faces?: { boxes: FaceBox[]; rotation: number; crop: CropBox | null } | null;
	/** 拼接 / 切割（或之前的编辑）还在等后台生成新图：盖一层黑色遮罩 */
	processing?: boolean;
}) {
	// 编辑完成后 URL 不变（版本号在提交时就已经更新，新图生成之前读到的是旧图），用 bust 参数强制重新加载
	const suffix = bust ? `&b=${bust}` : "";
	const src = previewUrl(id, rev) + suffix;
	// 挂载时预览已经就绪：一开始就不画缩略图
	const [instant] = useState(() => ready.has(src));
	const [loaded, setLoaded] = useState(instant);
	const [playing, setPlaying] = useState(false);
	const videoRef = useRef<HTMLVideoElement>(null);
	const sources = live ? videoSources(live) : [];
	const [srcIndex, setSrcIndex] = useState(0);
	const previewRef = useRef<HTMLImageElement>(null);

	// 带声音播放；浏览器不允许（没有刚发生的点击，比如 iOS 上打开时的自动播放）就静音播放
	const play = () => {
		const v = videoRef.current;
		if (!v) return;
		v.currentTime = 0;
		v.muted = false;
		const shown = () => setPlaying(true);
		void v.play().then(shown, (e: unknown) => {
			if (!(e instanceof DOMException && e.name === "NotAllowedError")) return setPlaying(false);
			v.muted = true;
			void v.play().then(shown, () => setPlaying(false));
		});
	};

	// 浏览器内存里已经有这张预览（预加载还没解码完之类），绘制前就标记为已加载，缩略图不会露出来
	useLayoutEffect(() => {
		const el = previewRef.current;
		if (el?.complete && el.naturalWidth) setLoaded(true);
	}, [src]);

	// 打开时自动播放一次（只看打开那一刻的开关，之后再打开不会补播）
	useEffect(() => {
		if (live && sources.length && autoplay) play();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [live?.id, sources.length]);
	// 点了顶栏的 Live 按钮（换照片时重新挂载，挂载那一刻的计数不算）
	const mountNonce = useRef(playNonce);
	useLayoutEffect(() => {
		if (playNonce !== mountNonce.current) play();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [playNonce]);
	// 关掉自动播放时停下正在播的
	useEffect(() => {
		if (autoplay) return;
		videoRef.current?.pause();
		setPlaying(false);
	}, [autoplay]);

	return (
		<div
			className="relative flex h-full w-full items-center justify-center"
			onPointerEnter={(e) => e.pointerType === "mouse" && live && autoplay && play()}
		>
			{!instant && (
				<img
					src={thumbUrl(id, rev) + suffix}
					alt=""
					aria-hidden
					className={`absolute max-h-full max-w-full object-contain blur-sm transition-opacity ${loaded ? "opacity-0" : "opacity-100"}`}
					// 缩略图只有几百像素，按照片尺寸撑到和预览一样大，换成预览时不会由小变大
					style={dims ? { width: dims[0], height: dims[1] } : undefined}
					draggable={false}
				/>
			)}
			<img
				ref={previewRef}
				src={src}
				alt=""
				// 已经解码过的预览同步绘制，不留一帧空白
				decoding={instant ? "sync" : "async"}
				onLoad={(e) => {
					setLoaded(true);
					markReady(src, e.currentTarget);
				}}
				className="relative max-h-full max-w-full object-contain"
				draggable={false}
			/>
			{loaded && upgraded ? (
				<OriginalOverlay
					key={upgraded}
					preview={previewRef}
					original={{ url: upgraded, heic: false }}
					rotation={0}
					crop={null}
					scale={scale}
					force
					onResult={onOriginal}
				/>
			) : (
				loaded &&
				original && (
					<OriginalOverlay
						// 加载失败后再点“加载原图”要重新挂载，才会重新请求
						key={forceOriginal ? "force" : "auto"}
						preview={previewRef}
						original={original}
						rotation={rotation}
						crop={crop}
						scale={scale}
						force={forceOriginal}
						onResult={onOriginal}
					/>
				)
			)}
			{processing && <PreviewVeil preview={previewRef} />}
			{loaded && faces && <FaceRings preview={previewRef} boxes={faces.boxes} rotation={faces.rotation} crop={faces.crop} scale={scale} />}
			{live && sources[srcIndex] && (
				<Framed preview={previewRef} rotation={rotation} crop={crop} className={`transition-opacity ${playing ? "opacity-100" : "opacity-0"}`}>
					{(style) => (
						<video
							ref={videoRef}
							src={sources[srcIndex]}
							playsInline
							preload="auto"
							onEnded={() => setPlaying(false)}
							onError={() => setSrcIndex((i) => i + 1)}
							className="absolute max-w-none object-cover"
							style={style}
						/>
					)}
				</Framed>
			)}
		</div>
	);
}

/** 正在处理的照片：和预览重合的黑色遮罩。 */
function PreviewVeil({ preview }: { preview: React.RefObject<HTMLImageElement | null> }) {
	const box = usePreviewBox(preview);
	if (!box) return null;
	return <ProcessingVeil style={{ left: box.l, top: box.t, width: box.w, height: box.h }} />;
}

/** 预览图在 Still 里的位置和大小（叠在它上面的东西按这个摆放），随布局变化更新。 */
function usePreviewBox(preview: React.RefObject<HTMLImageElement | null>) {
	const [box, setBox] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
	useEffect(() => {
		const el = preview.current;
		if (!el) return;
		const measure = () => setBox({ l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [preview]);
	return box;
}

/**
 * 叠在预览上的“整张图”（原图、Live 视频：没转过、没裁过）：外层和预览重合并裁掉框外的部分，
 * 里面的元素按裁切框放大、平移，再用 CSS 转到预览的角度。children 拿到里层元素的样式。
 */
function Framed({
	preview,
	rotation,
	crop,
	className = "",
	children,
}: {
	preview: React.RefObject<HTMLImageElement | null>;
	rotation: number;
	crop: CropBox | null;
	className?: string;
	children: (style: React.CSSProperties) => React.ReactNode;
}) {
	const box = usePreviewBox(preview);
	if (!box) return null;
	const c = crop ?? { x: 0, y: 0, w: 1, h: 1 };
	// 旋转之后、裁切之前的整张图在屏幕上的大小
	const fw = box.w / c.w;
	const fh = box.h / c.h;
	const sideways = rotation % 180 !== 0;
	const w = sideways ? fh : fw;
	const h = sideways ? fw : fh;
	return (
		<div className={`pointer-events-none absolute overflow-hidden ${className}`} style={{ left: box.l, top: box.t, width: box.w, height: box.h }}>
			{children({
				left: -c.x * fw + (fw - w) / 2,
				top: -c.y * fh + (fh - h) / 2,
				width: w,
				height: h,
				transform: rotation ? `rotate(${rotation}deg)` : undefined,
			})}
		</div>
	);
}

/** 圆圈比人脸框大这么多，不压住脸。 */
const FACE_RING_PAD = 1.4;

/** 人物页打开的照片：用圆圈标出被归为这个人物的脸。随照片一起缩放，线宽保持不变。 */
function FaceRings({
	preview,
	boxes,
	rotation,
	crop,
	scale,
}: {
	preview: React.RefObject<HTMLImageElement | null>;
	boxes: FaceBox[];
	rotation: number;
	crop: CropBox | null;
	scale: number;
}) {
	const box = usePreviewBox(preview);
	if (!box) return null;
	return (
		<div aria-hidden className="pointer-events-none absolute fade-in" style={{ left: box.l, top: box.t, width: box.w, height: box.h }}>
			{boxes.map((b, i) => {
				const r = cropFaceBox(rotateFaceBox(b, rotation), crop);
				if (!r) return null;
				const d = Math.max(r.w * box.w, r.h * box.h) * FACE_RING_PAD;
				return (
					<span
						key={i}
						className="absolute rounded-full border-white shadow-md"
						style={{
							left: (r.x + r.w / 2) * box.w - d / 2,
							top: (r.y + r.h / 2) * box.h - d / 2,
							width: d,
							height: d,
							borderWidth: 2 / scale,
						}}
					/>
				);
			})}
		</div>
	);
}

/** 预览图在屏幕上被拉伸（实际占的物理像素多于它本身的像素）时才加载原图。 */
const UPGRADE_RATIO = 1;
/** 停在这张照片上这么久才开始下载原图，快速翻页时不浪费流量。 */
const UPGRADE_DELAY_MS = 400;

/**
 * 原图叠层：盖在预览图上，位置和大小跟预览完全一致（布局只由预览决定，换图时画面不跳）。
 *  - 只在屏幕需要的像素超过预览时加载（高分屏全屏、放大），一旦加载就不再卸下。force（点了“加载原图”）时马上加载。
 *  - 原图没有经过服务端旋转，用 CSS 转到和预览相同的角度；EXIF 方向由浏览器处理，和 vips 一致。
 *  - 解码完成后才淡入；加载失败就一直用预览。
 */
function OriginalOverlay({
	preview,
	original,
	rotation,
	crop,
	scale,
	force = false,
	onResult,
}: {
	preview: React.RefObject<HTMLImageElement | null>;
	original: { url: string; heic: boolean };
	rotation: number;
	crop: CropBox | null;
	scale: number;
	force?: boolean;
	onResult?: (ok: boolean) => void;
}) {
	const box = usePreviewBox(preview);
	const [want, setWant] = useState(false);
	const [src, setSrc] = useState<string | null>(null);
	const [shown, setShown] = useState(false);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		const el = preview.current;
		if (want || !box || !el?.naturalWidth) return;
		if ((box.w * window.devicePixelRatio * scale) / el.naturalWidth > UPGRADE_RATIO) setWant(true);
	}, [box, scale, want, preview]);

	useEffect(() => {
		if (src) return;
		if (force) return setSrc(original.url);
		if (!want) return;
		const t = setTimeout(() => setSrc(original.url), UPGRADE_DELAY_MS);
		return () => clearTimeout(t);
	}, [want, src, force, original.url]);

	if (!box || !src || failed) return null;
	return (
		<Framed preview={preview} rotation={rotation} crop={crop} className={`transition-opacity duration-300 ${shown ? "opacity-100" : "opacity-0"}`}>
			{(style) => (
				<img
					src={src}
					alt=""
					decoding="async"
					draggable={false}
					onLoad={(e) => {
						const img = e.currentTarget;
						// 等解码完再显示，避免大图一行行画出来
						const done = () => {
							setShown(true);
							onResult?.(true);
						};
						void img.decode().then(done, done);
					}}
					onError={() => {
						if (original.heic) markHeicBroken();
						setFailed(true);
						onResult?.(false);
					}}
					className="absolute max-w-none object-fill"
					style={style}
				/>
			)}
		</Framed>
	);
}

/** 查看器顶栏的“加载原图”。窄屏只显示图标，状态靠图标样式和顶部的提示。 */
function HdButton({ plan, state, onClick }: { plan: HdPlan; state: HdState; onClick: () => void }) {
	// 状态优先：全尺寸预览生成好之后 plan 会先变成 best，但新图还在下载
	const [label, text] =
		state === "loading"
			? [plan.kind === "direct" ? t.viewer.hdLoadingDirectLabel : t.viewer.hdGeneratingLabel, t.viewer.hdLoading]
			: state === "shown"
				? [t.viewer.hdShowingLabel, t.viewer.hdShowing]
				: plan.kind === "best"
					? [t.viewer.hdBestLabel, t.viewer.hdBest]
					: state === "failed"
						? [t.viewer.hdRetryLabel, t.viewer.hdRetry]
						: [t.viewer.hdLoad, t.viewer.hdLoad];
	return (
		<button
			type="button"
			aria-label={label}
			aria-pressed={state === "shown"}
			aria-busy={state === "loading"}
			title={label}
			onClick={onClick}
			className={`flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 text-xs font-semibold transition hover:bg-white/15 ${
				state === "shown" ? "bg-white/15 text-fg" : plan.kind === "best" ? "text-muted" : "text-fg"
			}`}
		>
			<IconHd className={state === "loading" ? "animate-pulse" : ""} />
			<span className="hidden sm:inline">{text}</span>
		</button>
	);
}

type HdState = "idle" | "loading" | "shown" | "failed";

/** 等服务端生成全尺寸预览：每 2 秒看一次，最多 100 次（约 3 分钟，和服务端的生成超时相当）。 */
const HD_POLL_MS = 2000;
const HD_POLL_MAX = 100;

/**
 * “加载原图”的状态（按照片 ID 记，换照片就重新开始）。
 *  - direct：让叠层马上加载原件；
 *  - upgrade：POST /full-preview，然后有上限地轮询条目，直到 preview_edge 达到要的尺寸，再把新预览叠上去。
 */
function useHd(id: string, asset: AssetDetail | undefined, onUpgraded: () => void) {
	const qc = useQueryClient();
	const plan = asset && asset.id === id ? hdPlan(asset) : null;
	type S = { id: string; state: HdState; force: boolean; upgraded: string | null };
	const initial = (forId: string): S => ({ id: forId, state: "idle", force: false, upgraded: null });
	const [raw, setRaw] = useState<S>(() => initial(id));
	const cur = raw.id === id ? raw : initial(id);
	const idRef = useRef(id);
	idRef.current = id;
	const set = useCallback((forId: string, patch: Partial<S>) => {
		if (idRef.current !== forId) return;
		setRaw((prev) => ({ ...(prev.id === forId ? prev : initial(forId)), ...patch }));
	}, []);

	const load = async () => {
		if (!plan || plan.kind === "best" || cur.state === "loading" || cur.state === "shown") return;
		const forId = id;
		if (plan.kind === "direct") return set(forId, { state: "loading", force: true });
		set(forId, { state: "loading" });
		try {
			const r = await api<{ state: "done" | "queued"; edge: number }>(`/assets/${forId}/full-preview`, { method: "POST" });
			for (let i = 0; i < HD_POLL_MAX && idRef.current === forId; i++) {
				if (i) await new Promise((res) => setTimeout(res, HD_POLL_MS));
				if (idRef.current !== forId) return;
				const fresh = await qc.fetchQuery({
					queryKey: ["asset", forId],
					queryFn: () => api<AssetDetail>(`/assets/${forId}`),
					staleTime: 0,
				});
				if ((fresh.preview_edge ?? 0) >= r.edge && !fresh.jobs_active) {
					if (idRef.current !== forId) return;
					onUpgraded();
					// 新的 URL（带上尺寸），不会拿到浏览器里缓存的旧预览
					set(forId, { upgraded: `${previewUrl(forId, fresh.derived_rev)}&hd=${fresh.preview_edge}` });
					return;
				}
			}
			set(forId, { state: "failed" });
		} catch {
			set(forId, { state: "failed" });
		}
	};
	return {
		plan,
		state: cur.state,
		force: cur.force,
		upgraded: cur.upgraded,
		load,
		/** 叠层的结果：原图（或新预览）显示出来了，或者加载失败 */
		report: (ok: boolean) => set(id, { state: ok ? "shown" : "failed", ...(ok ? {} : { force: false, upgraded: null }) }),
	};
}

function VideoPlayer({ asset, poster }: { asset: AssetDetail; poster: string }) {
	const sources = videoSources(asset);
	const [i, setI] = useState(0);
	if (!sources[i]) return <p className="text-sm text-muted">{t.viewer.videoUnsupported}</p>;
	return (
		<video
			key={sources[i]}
			src={sources[i]}
			poster={poster}
			controls
			autoPlay
			playsInline
			onError={() => setI((n) => n + 1)}
			className="max-h-full max-w-full"
		/>
	);
}

/** 等后台生成编辑后的新图：每 2 秒看一次，最多 30 次（约 1 分钟，和 rotate 任务的超时相当）。 */
const EDIT_POLL_MS = 2000;
const EDIT_POLL_MAX = 30;

/**
 * 编辑的保存：PATCH 角度和裁切框（服务端版本号 +1、建 rotate 任务），保存期间用 pending（底图 + CSS）显示编辑结果，
 * 等后台生成好（有上限的轮询）再换成新图：version 加一，预览按新地址重新加载。
 * 等待期间这张照片带“正在处理”的遮罩（library/processing.ts，格子里也有）；换了照片、关掉查看器也照样等到结束，
 * 遮罩才会在新图生成好时去掉。
 */
function useEditSave(id: string, asset: AssetDetail | undefined, onDone: () => void) {
	const qc = useQueryClient();
	const [pending, setPending] = useState<{ id: string; spec: EditPreviewSpec } | null>(null);
	const [version, setVersion] = useState(0);

	const save = async (r: EditResult) => {
		if (!asset) return;
		const forId = id;
		const fromRev = asset.derived_rev;
		setPending({ id: forId, spec: r.preview });
		markProcessing([forId]);
		try {
			await api(`/assets/${forId}`, { method: "PATCH", json: { rotation: r.rotation, crop: r.crop, mask: r.mask } });
			// 已经保存了：轮询出错（断网之类）就不等了，之后刷新列表时会拿到新图
			try {
				for (let i = 0; i < EDIT_POLL_MAX; i++) {
					await new Promise((res) => setTimeout(res, EDIT_POLL_MS));
					const fresh = await qc.fetchQuery({
						queryKey: ["asset", forId],
						queryFn: () => api<AssetDetail>(`/assets/${forId}`),
						staleTime: 0,
					});
					if (fresh.derived_rev > fromRev && !fresh.jobs_active) break;
				}
			} catch {}
			onDone();
			setVersion((v) => v + 1);
		} finally {
			setPending((p) => (p?.id === forId ? null : p));
			unmarkProcessing([forId]);
		}
	};
	return { pending: pending?.id === id ? pending.spec : null, version, save };
}
