import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ASSET_TYPES, type AssetType } from "@nana/shared";
import { t } from "../i18n";
import { api } from "../api";
import { LibraryList } from "../library/LibraryList";
import { smartSetsQuery } from "../library/queries";
import { ASSET_TYPE_LABELS } from "../library/TypeFilter";
import { FaceAvatar, peopleQuery, personName } from "../people/model";
import { IconChevronRight, IconClose, IconHeart, IconMap, IconSearch, IconSimilar } from "../ui/icons";
import { useDocumentTitle } from "../ui/title";
import { Cover } from "./LibraryPages";
import { smartSetLine } from "./SmartSetPages";

const field = "h-9 rounded-full border border-border bg-card px-3 text-sm font-medium text-fg";

/** 照片类型（处理时从元数据识别）：值就是 /api/search 的 type 参数 */
const PHOTO_TYPES = (["burst", "panorama", "long-exposure", "portrait", "raw"] as const).map((type) => [type, ASSET_TYPE_LABELS[type]] as const);
/** 媒体类型走 /api/search 的 kind 参数，照片类型带 "t:" 前缀走 type 参数（和下拉框的值一致） */
const MEDIA_KINDS = new Set<AssetType>(["photo", "video", "live"]);
const kindValue = (type: AssetType) => (MEDIA_KINDS.has(type) ? type : `t:${type}`);

/** 探索页的地址参数：搜索词（?q=，顶栏的搜索框也写这里）和查看器打开的照片（?a=） */
export const exploreSearch = (s: Record<string, unknown>): { a?: string; q?: string } => ({
	a: typeof s.a === "string" && /^[0-9A-Z]{26}$/.test(s.a) ? s.a : undefined,
	q: typeof s.q === "string" && s.q ? s.q.slice(0, 200) : undefined,
});

/**
 * 搜索词：顶栏（桌面）和探索页（手机）的输入框共用，都写进 /search 的 ?q=。在别的页面输入会跳到探索页，
 * 在探索页上输入只替换地址，不多出历史记录。输入框自己保存正在输入的值，地址被外部改掉（后退、离开探索页）时才跟着变。
 */
export function useSearchInput(): [string, (value: string) => void] {
	const onExplore = useRouterState({ select: (s) => s.location.pathname === "/search" });
	const { q } = useSearch({ strict: false }) as { q?: string };
	const navigate = useNavigate();
	const urlQ = onExplore ? (q ?? "") : "";
	const [value, setValue] = useState(urlQ);
	const typed = useRef(urlQ);
	useEffect(() => {
		if (urlQ === typed.current) return;
		typed.current = urlQ;
		setValue(urlQ);
	}, [urlQ]);
	const change = useCallback(
		(v: string) => {
			setValue(v);
			typed.current = v;
			void navigate({
				to: "/search",
				search: (prev: Record<string, unknown>) => ({ ...(onExplore ? prev : {}), q: v || undefined, a: undefined }),
				replace: onExplore,
			});
		},
		[navigate, onExplore],
	);
	return [value, change];
}

/** 搜索框本体：顶栏和探索页（只在手机上显示）共用 */
export function SearchBox({ className = "", autoFocus }: { className?: string; autoFocus?: boolean }) {
	const [value, setValue] = useSearchInput();
	return (
		<label
			className={`flex items-center gap-3 rounded-full border border-transparent bg-surface px-4 transition focus-within:border-border focus-within:bg-card focus-within:shadow-[0_2px_12px_rgb(0_0_0/0.08)] ${className}`}
		>
			<IconSearch className="shrink-0 text-fg" />
			<input
				type="search"
				autoFocus={autoFocus}
				className="h-full min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-muted focus-visible:outline-none md:text-sm [&::-webkit-search-cancel-button]:hidden"
				placeholder={t.nav.searchHint}
				aria-label={t.search.placeholder}
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => e.key === "Escape" && value && setValue("")}
				maxLength={200}
			/>
			{value && (
				<button type="button" className="-mr-2 flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-surface-2" aria-label={t.search.clear} onClick={() => setValue("")}>
					<IconClose size={18} />
				</button>
			)}
		</label>
	);
}

/**
 * 探索：没有搜索词、没有筛选时是入口页（人物、主题、地图、按类型）；
 * 输入关键词或选了筛选条件就显示搜索结果。搜索的是文件名和描述，加上日期、类型、收藏、相机筛选。
 */
export function SearchPage() {
	useDocumentTitle(t.nav.explore);
	const { q } = useSearch({ strict: false }) as { q?: string };
	const [debouncedQ, setDebouncedQ] = useState(q?.trim() ?? "");
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [kind, setKind] = useState("");
	const [camera, setCamera] = useState("");
	const [favorite, setFavorite] = useState(false);
	const cameras = useQuery({
		queryKey: ["search", "cameras"],
		queryFn: () => api<{ camera: string; count: number }[]>("/search/cameras"),
	});

	// 输入停顿 300ms 后才搜索
	useEffect(() => {
		const timer = setTimeout(() => setDebouncedQ(q?.trim() ?? ""), 300);
		return () => clearTimeout(timer);
	}, [q]);

	const qs = useMemo(() => {
		const p = new URLSearchParams();
		if (debouncedQ) p.set("q", debouncedQ);
		if (from) p.set("from", from);
		if (to) p.set("to", to);
		// 照片类型的值带 "t:" 前缀，和媒体类型区分
		if (kind.startsWith("t:")) p.set("type", kind.slice(2));
		else if (kind) p.set("kind", kind);
		if (camera) p.set("camera", camera);
		if (favorite) p.set("favorite", "1");
		return p.toString();
	}, [debouncedQ, from, to, kind, camera, favorite]);

	const active = !!(from || to || kind || camera || favorite);
	return (
		<div className="space-y-6">
			<div className="space-y-3 pt-1">
				{/* 桌面的搜索框在顶栏；手机顶栏没有，放在这里 */}
				<SearchBox className="h-12 md:hidden" />
				<div className="flex flex-wrap items-center gap-2 text-sm">
					<label className={`${field} flex items-center gap-1.5 focus-within:border-fg/40`}>
						<span className="text-muted">{t.search.from}</span>
						<input type="date" className="bg-transparent text-fg outline-none" value={from} onChange={(e) => setFrom(e.target.value)} />
					</label>
					<label className={`${field} flex items-center gap-1.5 focus-within:border-fg/40`}>
						<span className="text-muted">{t.search.to}</span>
						<input type="date" className="bg-transparent text-fg outline-none" value={to} onChange={(e) => setTo(e.target.value)} />
					</label>
					<select className={`${field} ${kind ? "!border-transparent !bg-fg !text-bg" : ""}`} value={kind} onChange={(e) => setKind(e.target.value)} aria-label={t.info.type}>
						<option value="">{t.search.allTypes}</option>
						<option value="photo">{t.library.types.photo}</option>
						<option value="live">{t.library.types.live}</option>
						<option value="video">{t.library.types.video}</option>
						<optgroup label={t.search.photoTypes}>
							{PHOTO_TYPES.map(([v, label]) => (
								<option key={v} value={`t:${v}`}>
									{label}
								</option>
							))}
						</optgroup>
					</select>
					<select className={`${field} max-w-56 ${camera ? "!border-transparent !bg-fg !text-bg" : ""}`} value={camera} onChange={(e) => setCamera(e.target.value)} aria-label={t.info.camera}>
						<option value="">{t.search.allCameras}</option>
						{cameras.data?.map((c) => (
							<option key={c.camera} value={c.camera}>
								{t.search.cameraCount(c.camera, c.count)}
							</option>
						))}
					</select>
					<label className={`${field} flex cursor-pointer items-center gap-1.5 ${favorite ? "!border-transparent !bg-fg !text-bg" : ""}`}>
						<input type="checkbox" className="sr-only" checked={favorite} onChange={(e) => setFavorite(e.target.checked)} />
						<IconHeart size={16} filled={favorite} />
						{t.search.favoritesOnly}
					</label>
					{active && (
						<button
							type="button"
							className="h-9 rounded-full px-3 text-sm font-medium text-accent hover:bg-surface"
							onClick={() => {
								setFrom("");
								setTo("");
								setKind("");
								setCamera("");
								setFavorite(false);
							}}
						>
							{t.search.clearFilters}
						</button>
					)}
				</div>
			</div>
			{qs ? (
				<LibraryList key={qs} source={{ key: ["search", qs], path: `/search?${qs}` }} context={{ kind: "library" }} empty={t.search.none} />
			) : (
				<ExploreHome onType={(type) => setKind(kindValue(type))} />
			)}
		</div>
	);
}

/** 没有搜索时的入口。人物、主题和列表页共用缓存（带 ETag），不额外请求。 */
function ExploreHome({ onType }: { onType: (type: AssetType) => void }) {
	return (
		<div className="space-y-8">
			<PeopleStrip />
			<SmartSetStrip />
			<section className="space-y-3">
				<h2 className="text-lg font-bold">{t.explore.more}</h2>
				<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
					<Shortcut to="/map" icon={<IconMap />} title={t.nav.map} sub={t.explore.mapSub} />
				</div>
			</section>
			<section className="space-y-3">
				<h2 className="text-lg font-bold">{t.explore.byType}</h2>
				<div className="flex flex-wrap gap-2">
					{ASSET_TYPES.filter((type) => type !== "photo").map((type) => (
						<button
							key={type}
							type="button"
							className="h-9 rounded-full border border-border bg-card px-4 text-sm font-medium text-fg transition hover:bg-surface"
							onClick={() => onType(type)}
						>
							{ASSET_TYPE_LABELS[type]}
						</button>
					))}
				</div>
			</section>
		</div>
	);
}

function SectionHead({ title, to }: { title: string; to?: "/people" | "/smart-sets" }) {
	return (
		<div className="flex items-baseline gap-2">
			<h2 className="text-lg font-bold">{title}</h2>
			{to && (
				<Link to={to} className="ml-auto flex shrink-0 items-center gap-0.5 self-center rounded-full px-2 py-1 text-sm font-medium text-accent-ink hover:bg-surface">
					{t.explore.all}
					<IconChevronRight size={16} />
				</Link>
			)}
		</div>
	);
}

const strip = "-mx-2 flex snap-x snap-mandatory scroll-px-2 gap-3 overflow-x-auto px-2 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/** 人物：服务端已经把个人收藏排在前面，取前面的一些 */
function PeopleStrip() {
	const { data } = useQuery(peopleQuery());
	const people = data?.items.slice(0, 16);
	if (!people?.length) return null;
	return (
		<section className="space-y-3">
			<SectionHead title={t.people.title} to="/people" />
			<div className={strip}>
				{people.map((p) => (
					<Link
						key={p.id}
						to="/people/$personId"
						params={{ personId: p.id }}
						className="flex w-20 shrink-0 snap-start flex-col items-center gap-1.5 sm:w-24"
						aria-label={t.people.cardLabel(personName(p), p.count)}
					>
						<span className="block aspect-square w-full transition hover:opacity-90">
							<FaceAvatar face={p.cover} className="h-full w-full" />
						</span>
						<span className={`w-full truncate text-center text-xs font-medium ${p.name ? "" : "text-muted"}`}>{personName(p)}</span>
					</Link>
				))}
			</div>
		</section>
	);
}

/**
 * 主题：横向滚动的卡片，点卡片进入这个主题，“全部”进入主题列表（重命名、删除在那里）。
 * 卡片不用 ul / li：scripts/perf 的脚本把页面上的 `ul li a` 当作相册 / 文件夹卡片。
 */
function SmartSetStrip() {
	const { data } = useQuery(smartSetsQuery);
	if (!data) return null;
	return (
		<section className="space-y-3">
			<SectionHead title={t.topics.title} to="/smart-sets" />
			{data.length === 0 ? (
				<Link to="/smart-sets" className="flex items-start gap-2.5 rounded-2xl bg-notice px-4 py-3 text-sm hover:opacity-90">
					<IconSimilar size={18} className="mt-0.5 shrink-0 text-muted" />
					<span>{t.topics.stripNone}</span>
				</Link>
			) : (
				<div className={strip}>
					{data.map((s) => (
						<Link key={s.id} to="/smart-sets/$setId" params={{ setId: s.id }} className="w-32 shrink-0 snap-start space-y-1.5 sm:w-40">
							<Cover cover={s.cover} label="album" />
							<div className="flex items-center gap-1.5">
								<span className="truncate text-sm font-semibold">{s.name}</span>
								{s.dirty && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" title={t.topics.dirtyDot} />}
							</div>
							<div className="text-xs text-muted">{smartSetLine(s)}</div>
						</Link>
					))}
				</div>
			)}
		</section>
	);
}

function Shortcut({ to, icon, title, sub }: { to: "/map"; icon: React.ReactNode; title: string; sub: string }) {
	return (
		<Link to={to} className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 transition hover:bg-surface">
			<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-ink">{icon}</span>
			<div className="min-w-0 flex-1">
				<div className="text-sm font-semibold">{title}</div>
				<div className="truncate text-xs text-muted">{sub}</div>
			</div>
			<IconChevronRight className="shrink-0 text-muted" />
		</Link>
	);
}
