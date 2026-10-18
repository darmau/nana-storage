import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { errorText } from "../api";
import { t } from "../i18n";
import { type ListSource, listQuery } from "../library/queries";
import { KIND_VIDEO, previewUrl, type TimelineItem } from "../timeline/types";
import { IconChevronLeft, IconChevronRight, IconClose, IconPause, IconPlay, IconShuffle } from "../ui/icons";
import { useThemeColor } from "../ui/themeColor";

/**
 * 幻灯片：文件夹 / 相册里的照片全屏轮播（视频跳过，Live Photo 只放静态图）。
 *  - 用和列表相同的分页查询（共享缓存）。顺序播放时快到末尾才加载下一页；随机播放时逐页加载全部，
 *    最多 MAX_PAGES 页，每次只有一个请求在跑，出错就停。
 *  - 下一张的预览图提前下载并解码好，计时从这一张显示出来开始算，图片请求的频率不超过每 3 秒一张。
 *  - 进入时请求浏览器全屏，退出全屏即退出幻灯片；不支持全屏的（iPhone）就铺满窗口。
 *  - 空格暂停，←/→ 切换，Esc 退出。播放间隔和是否随机记在 localStorage 里。
 */

/** 每页 500 条，最多 10 万张 */
const MAX_PAGES = 200;
/** 顺序播放时，离已加载的末尾还剩这么多张就加载下一页 */
const PREFETCH_REMAINING = 20;
const INTERVALS = [3, 5, 10, 15, 30, 60];
const SETTINGS_KEY = "nana.slideshow";
const HIDE_CONTROLS_MS = 3000;
const HISTORY_LIMIT = 500;

interface Settings {
	seconds: number;
	shuffle: boolean;
}

function loadSettings(): Settings {
	try {
		const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<Settings> | null;
		if (s && INTERVALS.includes(s.seconds!) && typeof s.shuffle === "boolean") return { seconds: s.seconds!, shuffle: s.shuffle };
	} catch {
		// 隐私模式等情况下读不到，用默认值
	}
	return { seconds: 5, shuffle: false };
}

function saveSettings(s: Settings) {
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
	} catch {
		// 忽略
	}
}

/** 下载并解码好再返回；失败也返回（显示出来是空白，计时照常，不会卡住）。 */
function preload(url: string): Promise<void> {
	const img = new Image();
	img.src = url;
	return img.decode().catch(() => undefined);
}

interface Slide {
	key: number;
	id: string;
	rev: number;
}

export function Slideshow({ source, onClose }: { source: ListSource; onClose: () => void }) {
	const query = useInfiniteQuery(listQuery(source));
	const photos = useMemo<TimelineItem[]>(
		() => query.data?.pages.flatMap((p) => p.items).filter((it) => it[3] !== KIND_VIDEO) ?? [],
		[query.data],
	);
	const loadedAll = query.isSuccess && !query.hasNextPage;
	const [settings, setSettings] = useState(loadSettings);
	const update = (patch: Partial<Settings>) =>
		setSettings((s) => {
			const next = { ...s, ...patch };
			saveSettings(next);
			return next;
		});
	const [playing, setPlaying] = useState(true);
	useThemeColor("#000000");
	const [slides, setSlides] = useState<Slide[]>([]);
	const current = slides.at(-1)?.id ?? null;

	// ---------------------------------------------------------------- 分页加载
	const pages = query.data?.pages.length ?? 0;
	const index = current ? photos.findIndex((it) => it[0] === current) : -1;
	const needMore = settings.shuffle || index < 0 || photos.length - index <= PREFETCH_REMAINING;
	useEffect(() => {
		if (needMore && query.hasNextPage && !query.isFetchingNextPage && !query.isError && pages < MAX_PAGES) void query.fetchNextPage();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [needMore, query.hasNextPage, query.isFetchingNextPage, query.isError, pages]);

	// ---------------------------------------------------------------- 播放顺序
	const played = useRef(new Set<string>());
	const history = useRef<string[]>([]);
	const pick = useCallback(
		(from: string | null): TimelineItem | null => {
			if (!photos.length) return null;
			if (settings.shuffle) {
				let pool = photos.filter((it) => !played.current.has(it[0]) && it[0] !== from);
				if (!pool.length) {
					// 都放过一遍了，重新开始一轮（加载中的页还没到时先等等）
					if (!loadedAll) return null;
					played.current.clear();
					pool = photos.filter((it) => it[0] !== from);
				}
				return pool[Math.floor(Math.random() * pool.length)] ?? null;
			}
			const i = from ? photos.findIndex((it) => it[0] === from) : -1;
			if (i + 1 < photos.length) return photos[i + 1]!;
			return loadedAll ? photos[0]! : null;
		},
		[photos, settings.shuffle, loadedAll],
	);

	const seq = useRef(0);
	const currentRef = useRef<string | null>(null);
	const show = useCallback(async (it: TimelineItem, pushHistory = true) => {
		const token = ++seq.current;
		await preload(previewUrl(it[0], it[7]));
		if (token !== seq.current) return;
		if (pushHistory && currentRef.current) {
			history.current.push(currentRef.current);
			if (history.current.length > HISTORY_LIMIT) history.current.shift();
		}
		currentRef.current = it[0];
		played.current.add(it[0]);
		setSlides((s) => [...s.slice(-1), { key: token, id: it[0], rev: it[7] }]);
	}, []);

	// 下一张提前选好并预加载。只在换了一张或切换随机时重选，
	// 加载新页时不重选（否则随机模式每来一页就多下载一张预览）。
	const [upcoming, setUpcoming] = useState<TimelineItem | null>(null);
	useEffect(() => {
		setUpcoming(pick(current));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [current, settings.shuffle]);
	useEffect(() => {
		if (!upcoming) setUpcoming(pick(current));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [photos.length, loadedAll]);
	useEffect(() => {
		if (upcoming) void preload(previewUrl(upcoming[0], upcoming[7]));
	}, [upcoming]);

	const next = useCallback(() => {
		if (upcoming) void show(upcoming);
	}, [upcoming, show]);
	const prev = useCallback(() => {
		const id = history.current.pop();
		const it = id ? photos.find((p) => p[0] === id) : !settings.shuffle && index > 0 ? photos[index - 1] : undefined;
		if (it) void show(it, false);
	}, [photos, settings.shuffle, index, show]);

	// 第一张
	useEffect(() => {
		if (!current && seq.current === 0 && photos.length) {
			const first = settings.shuffle ? pick(null) : photos[0]!;
			if (first) void show(first);
		}
	}, [current, photos, settings.shuffle, pick, show]);

	// 自动播放：这一张显示出来之后开始计时
	useEffect(() => {
		if (!playing || !current || !upcoming) return;
		const t = setTimeout(next, settings.seconds * 1000);
		return () => clearTimeout(t);
	}, [playing, current, upcoming, next, settings.seconds]);

	// ---------------------------------------------------------------- 全屏、防休眠、键盘
	const root = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	useLayoutEffect(() => {
		const el = root.current;
		let entered = false;
		const onChange = () => {
			if (document.fullscreenElement === el) entered = true;
			else if (entered) closeRef.current();
		};
		document.addEventListener("fullscreenchange", onChange);
		el?.requestFullscreen?.().catch(() => undefined);
		const prevOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.removeEventListener("fullscreenchange", onChange);
			if (document.fullscreenElement === el) void document.exitFullscreen().catch(() => undefined);
			document.body.style.overflow = prevOverflow;
		};
	}, []);

	useEffect(() => {
		if (!playing || !("wakeLock" in navigator)) return;
		let lock: WakeLockSentinel | null = null;
		let released = false;
		const acquire = () => {
			if (document.visibilityState !== "visible") return;
			void navigator.wakeLock.request("screen").then(
				(l) => (released ? void l.release() : (lock = l)),
				() => undefined,
			);
		};
		acquire();
		document.addEventListener("visibilitychange", acquire);
		return () => {
			released = true;
			document.removeEventListener("visibilitychange", acquire);
			void lock?.release();
		};
	}, [playing]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLSelectElement) return;
			if (e.key === "Escape") onClose();
			else if (e.key === "ArrowRight") next();
			else if (e.key === "ArrowLeft") prev();
			else if (e.key === " ") {
				e.preventDefault();
				setPlaying((p) => !p);
			} else return;
			poke();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	// ---------------------------------------------------------------- 控制栏：有动作时显示，3 秒后隐藏
	const [controls, setControls] = useState(true);
	const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const poke = () => {
		setControls(true);
		clearTimeout(hideTimer.current);
		hideTimer.current = setTimeout(() => setControls(false), HIDE_CONTROLS_MS);
	};
	useEffect(() => {
		poke();
		return () => clearTimeout(hideTimer.current);
	}, []);
	const visible = controls || !playing;

	const empty = query.isSuccess && loadedAll && photos.length === 0;
	return (
		<div
			ref={root}
			className={`theme-dark fixed inset-0 z-50 select-none bg-black text-fg ${visible ? "" : "cursor-none"}`}
			role="dialog"
			aria-modal="true"
			aria-label={t.slideshow.dialog}
			onPointerMove={(e) => e.pointerType === "mouse" && poke()}
			onClick={(e) => {
				if (!(e.target as HTMLElement).closest("button, select, label")) {
					if (controls) setControls(false);
					else poke();
				}
			}}
		>
			{slides.map((s, i) => (
				<SlideImage key={s.key} slide={s} front={i === slides.length - 1} />
			))}

			{(empty || query.isError) && (
				<p className="absolute inset-0 z-10 flex items-center justify-center text-sm text-muted">
					{query.isError ? t.common.loadFailed(errorText(query.error)) : t.slideshow.empty}
				</p>
			)}

			<div className={`transition-opacity duration-300 ${visible ? "opacity-100" : "pointer-events-none opacity-0"}`}>
				<div className="absolute inset-x-0 top-0 z-10 flex items-center bg-gradient-to-b from-black/60 to-transparent pb-8 pl-[max(0.5rem,var(--safe-left))] pr-[max(0.5rem,var(--safe-right))] pt-[max(0.5rem,var(--safe-top))]">
					<button type="button" className="icon-btn hover:!bg-white/15" aria-label={t.slideshow.exit} title={t.slideshow.exitTitle} onClick={onClose}>
						<IconClose size={24} />
					</button>
					{index >= 0 && (
						<span className="ml-1 text-sm tabular-nums text-muted">
							{settings.shuffle ? t.slideshow.shuffleCount(photos.length, !loadedAll) : `${index + 1} / ${photos.length}${loadedAll ? "" : "+"}`}
						</span>
					)}
				</div>
				<div className="absolute inset-x-0 bottom-0 z-10 flex flex-wrap items-center justify-center gap-2 bg-gradient-to-t from-black/60 to-transparent px-4 pb-[max(1rem,var(--safe-bottom))] pt-10">
					<button type="button" className="icon-btn hover:!bg-white/15" aria-label={t.viewer.prev} title={t.slideshow.prevTitle} onClick={prev}>
						<IconChevronLeft size={26} />
					</button>
					<button
						type="button"
						className="icon-btn !h-14 !w-14 bg-white/10 hover:!bg-white/20"
						aria-label={playing ? t.slideshow.pause : t.slideshow.play}
						title={playing ? t.slideshow.pauseTitle : t.slideshow.playTitle}
						onClick={() => setPlaying((p) => !p)}
					>
						{playing ? <IconPause size={26} /> : <IconPlay size={26} />}
					</button>
					<button type="button" className="icon-btn hover:!bg-white/15" aria-label={t.viewer.next} title={t.slideshow.nextTitle} onClick={next}>
						<IconChevronRight size={26} />
					</button>
					<div className="mx-2 h-6 w-px bg-white/20" />
					<label className="flex items-center gap-1.5 text-sm">
						<span className="text-muted">{t.slideshow.interval}</span>
						<select
							className="h-9 rounded-full border border-white/20 bg-black/40 px-3 text-sm text-fg"
							value={settings.seconds}
							onChange={(e) => update({ seconds: Number(e.target.value) })}
						>
							{INTERVALS.map((s) => (
								<option key={s} value={s}>
									{s < 60 ? t.slideshow.seconds(s) : t.slideshow.minutes(s / 60)}
								</option>
							))}
						</select>
					</label>
					<button
						type="button"
						aria-pressed={settings.shuffle}
						onClick={() => update({ shuffle: !settings.shuffle })}
						className={`inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm transition ${
							settings.shuffle ? "border-transparent bg-white text-black" : "border-white/20 bg-black/40 text-fg hover:bg-white/15"
						}`}
					>
						<IconShuffle size={18} />
						{t.slideshow.shuffle}
					</button>
				</div>
			</div>
		</div>
	);
}

/**
 * 交叉淡入淡出：新的一张淡入，上一张同时淡出，下一次切换时移除。
 * 上一张不能留着不透明垫底：两张都是 object-contain，长宽比不同（横图换竖图）时新图盖不满，
 * 上一张会从两边露出来，看起来像两张叠在一起。
 */
function SlideImage({ slide, front }: { slide: Slide; front: boolean }) {
	const [shown, setShown] = useState(false);
	useEffect(() => {
		const raf = requestAnimationFrame(() => setShown(true));
		return () => cancelAnimationFrame(raf);
	}, []);
	return (
		<img
			src={previewUrl(slide.id, slide.rev)}
			alt=""
			draggable={false}
			className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-700 ${shown && front ? "opacity-100" : "opacity-0"} ${front ? "z-[1]" : ""}`}
		/>
	);
}
