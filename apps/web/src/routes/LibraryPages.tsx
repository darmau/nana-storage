import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { t } from "../i18n";
import { batch, invalidateLibrary } from "../library/actions";
import { LibraryList } from "../library/LibraryList";
import { armLibrarySync } from "../library/sync";
import { FolderPicker } from "../library/Pickers";
import { TypeFilter, usePersonFilter, useTypeFilter, withType } from "../library/TypeFilter";
import {
	type AlbumSummary,
	type FolderChild,
	type ListSource,
	type UnfinishedAsset,
	albumsQuery,
	coverUrl,
	folderQuery,
	folderUnfinishedQuery,
	listQuery,
} from "../library/queries";
import { alertDialog, confirmDialog, promptDialog } from "../ui/confirm";
import { type MenuItem, openContextMenu, openMenuAt } from "../ui/ContextMenu";
import {
	IconAlbum,
	IconChevronRight,
	IconEdit,
	IconFolder,
	IconFolderMove,
	IconGrid,
	IconList,
	IconInfo,
	IconMore,
	IconPlus,
	IconSlideshow,
	IconTrash,
} from "../ui/icons";
import { FolderPeople } from "../people/FolderPeople";
import { personQuery } from "../people/model";
import { uploadMenuItems } from "../upload/picker";
import { Slideshow } from "../viewer/Slideshow";
import { type FolderView, setFolderView, useFolderView } from "../ui/folderView";
import { useDocumentTitle } from "../ui/title";
import { AlbumCardsSkeleton, FolderCardsSkeleton, FolderRowsSkeleton } from "../ui/Skeleton";
import { fmtNumber } from "../i18n/format";
import { formatBytes, formatDateTime } from "../timeline/format";

const confirmAlbumDelete = (name: string) =>
	confirmDialog({ title: t.albums.deleteTitle(name), message: t.albums.deleteMessage, confirmLabel: t.albums.deleteAlbum, danger: true });

export function Cover({ cover, label }: { cover: string | null; label: "folder" | "album" }) {
	const url = coverUrl(cover);
	return (
		<div className="aspect-square overflow-hidden rounded-2xl bg-surface">
			{url ? (
				<img src={url} alt="" loading="lazy" className="h-full w-full object-cover transition duration-300 hover:scale-[1.03]" />
			) : (
				<div className="flex h-full items-center justify-center text-muted" aria-label={label === "folder" ? t.folders.emptyCover : t.albums.emptyCover}>
					{label === "folder" ? <IconFolder size={36} /> : <IconAlbum size={36} />}
				</div>
			)}
		</div>
	);
}

const NEAR_MARGIN = 600;

/**
 * 卡片离视口 NEAR_MARGIN 以内时为 true。挂载时先在绘制前同步量一次，
 * 视口附近的卡片第一帧就带图片（滑动返回时不会先空一下）；之后交给 IntersectionObserver。
 */
function useNear(ref: React.RefObject<HTMLElement | null>) {
	const [near, setNear] = useState(false);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const r = el.getBoundingClientRect();
		if (r.bottom > -NEAR_MARGIN && r.top < window.innerHeight + NEAR_MARGIN) setNear(true);
		const io = new IntersectionObserver(([e]) => setNear(!!e?.isIntersecting), { rootMargin: `${NEAR_MARGIN}px 0px` });
		io.observe(el);
		return () => io.disconnect();
	}, [ref]);
	return near;
}

/**
 * 文件夹封面：满 9 张拼九宫格，4–8 张拼四宫格，更少只显示最近的一张。
 * 只有离视口 600px 以内的卡片才挂载图片，滚远了就卸载：文件夹很多时（几百个 × 9 张缩略图）
 * 不会让解码后的图片把内存撑爆（iOS Safari 会直接崩掉标签页）。
 */
function FolderCover({ covers }: { covers: string[] }) {
	const ref = useRef<HTMLDivElement>(null);
	const near = useNear(ref);
	const shown = covers.slice(0, covers.length >= 9 ? 9 : covers.length >= 4 ? 4 : 1);
	if (!shown.length) return <Cover cover={null} label="folder" />;
	return (
		<div ref={ref} className="aspect-square overflow-hidden rounded-2xl bg-surface">
			{near && (
				<div
					className={`grid h-full w-full gap-px transition duration-300 hover:scale-[1.03] ${
						shown.length === 9 ? "grid-cols-3 grid-rows-3" : shown.length === 4 ? "grid-cols-2 grid-rows-2" : ""
					}`}
				>
					{shown.map((c) => (
						<img
							key={c}
							src={coverUrl(c) ?? undefined}
							alt=""
							className="h-full min-h-0 w-full object-cover"
							// 加载失败只留底色，不显示浏览器的破图标
							onError={(e) => (e.currentTarget.style.visibility = "hidden")}
						/>
					))}
				</div>
			)}
		</div>
	);
}

/** 列表视图的子文件夹：图标 | 名称 | 子文件夹 | 文件数 | 体积 | 上次修改。窄屏只有图标和名称，其余写在名称下面。 */
const FOLDER_COLS =
	"grid grid-cols-[40px_minmax(0,1fr)] items-center gap-3 sm:grid-cols-[40px_minmax(0,1fr)_5rem_5rem_6rem] lg:grid-cols-[40px_minmax(0,1fr)_5rem_5rem_6rem_11rem]";

function FolderRows({
	folders,
	unfinishedIn,
	onMenu,
}: {
	folders: FolderChild[];
	unfinishedIn: (f: FolderChild) => number;
	onMenu: (e: React.MouseEvent, f: FolderChild) => void;
}) {
	const cell = "hidden text-right text-sm tabular-nums text-muted sm:block";
	return (
		<div>
			<div className={`${FOLDER_COLS} hidden border-b border-border pb-2 text-xs font-medium text-muted sm:grid`} aria-hidden>
				<span />
				<span>{t.folders.colName}</span>
				<span className="text-right">{t.folders.colSubfolders}</span>
				<span className="text-right">{t.folders.colFiles}</span>
				<span className="text-right">{t.folders.colFolderSize}</span>
				<span className="hidden pr-3 text-right lg:block">{t.folders.colModified}</span>
			</div>
			<ul>
				{folders.map((f) => {
					const unfinished = unfinishedIn(f);
					const size = formatBytes(f.size);
					return (
						<li key={f.id}>
							<Link
								to="/folders/$folderId"
								params={{ folderId: f.id }}
								className={`${FOLDER_COLS} h-14 rounded-lg hover:bg-surface`}
								onContextMenu={(e) => onMenu(e, f)}
							>
								<span className="flex h-10 w-10 items-center justify-center text-[#b7791f] dark:text-[#f2c66d]">
									<IconFolder size={26} />
								</span>
								<span className="min-w-0">
									<div className="truncate text-sm font-semibold">{f.name}</div>
									<div className="truncate text-xs text-muted sm:hidden">
										{t.common.items(f.count)}
										{f.subfolders ? t.folders.subfoldersTag(f.subfolders) : ""}
										{f.size ? ` · ${size}` : ""}
										{unfinished ? t.folders.unfinishedTag(unfinished) : ""}
									</div>
									{unfinished > 0 && <div className="hidden truncate text-xs text-muted sm:block">{t.folders.unfinished(unfinished)}</div>}
								</span>
								<span className={cell}>{f.subfolders ? fmtNumber(f.subfolders) : "–"}</span>
								<span className={cell}>{fmtNumber(f.count)}</span>
								<span className={cell}>{f.size ? size : "–"}</span>
								<span className="hidden truncate pr-3 text-right text-sm tabular-nums text-muted lg:block">{formatDateTime(f.modified)}</span>
							</Link>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

/** 网格 / 列表切换，记在这台设备上（ui/folderView.ts），所有文件夹共用。 */
function ViewToggle({ view }: { view: FolderView }) {
	const toList = view === "grid";
	const label = toList ? t.folders.showList : t.folders.showGrid;
	return (
		<button className="icon-btn" aria-label={label} title={label} onClick={() => setFolderView(toList ? "list" : "grid")}>
			{toList ? <IconList /> : <IconGrid />}
		</button>
	);
}

/** 列表里有照片时才显示；和下面的网格共用同一个分页查询，不会多请求。 */
export function SlideshowButton({ source }: { source: ListSource }) {
	const query = useInfiniteQuery(listQuery(source));
	const [open, setOpen] = useState(false);
	if (!query.data?.pages[0]?.items.length) return null;
	return (
		<>
			<button className="btn max-sm:w-9 max-sm:px-0" onClick={() => setOpen(true)}>
				<IconSlideshow size={18} />
				<span className="sr-only sm:not-sr-only">{t.slideshow.dialog}</span>
			</button>
			{open && <Slideshow source={source} onClose={() => setOpen(false)} />}
		</>
	);
}

interface PageAction {
	label: string;
	icon: React.ReactNode;
	onSelect: () => void;
	danger?: boolean;
	/** 桌面按钮上也显示图标 */
	showIcon?: boolean;
}

/**
 * 页头操作：桌面直接显示 actions 的按钮，menu 收进右边的“更多”下拉菜单（重命名、删除这类不常用的）；
 * 手机上全部收进“更多”菜单，标题和路径不会被挤到换行。
 */
export function PageActions({ actions = [], menu = [] }: { actions?: PageAction[]; menu?: PageAction[] }) {
	const toItem = ({ label, icon, onSelect, danger }: PageAction): MenuItem => ({ label, icon, onSelect, danger });
	const menuItems = menu.map(toItem);
	const all: MenuItem[] = [...actions.map(toItem), ...(actions.length && menu.length ? ["sep" as const] : []), ...menuItems];
	return (
		<>
			{actions.map((a) => (
				<button key={a.label} className={`btn hidden sm:inline-flex ${a.danger ? "btn-danger" : ""}`} onClick={a.onSelect}>
					{a.showIcon && a.icon}
					{a.label}
				</button>
			))}
			{menu.length > 0 && (
				<button className="icon-btn -mr-2 hidden sm:inline-flex" aria-label={t.actions.more} aria-haspopup="menu" onClick={(e) => openMenuAt(e.currentTarget, menuItems)}>
					<IconMore />
				</button>
			)}
			<button className="icon-btn -mr-2 sm:hidden" aria-label={t.actions.more} aria-haspopup="menu" onClick={(e) => openMenuAt(e.currentTarget, all)}>
				<IconMore />
			</button>
		</>
	);
}

// ------------------------------------------------------------------ 文件夹

export function FoldersPage() {
	const { folderId = "root" } = useParams({ strict: false }) as { folderId?: string };
	const qc = useQueryClient();
	const navigate = useNavigate();
	const folder = useQuery(folderQuery(folderId));
	const { data, error } = folder;
	const { data: pending } = useQuery(folderUnfinishedQuery(folderId));
	useProcessingRefresh(pending?.items.filter((u) => u.state === "processing").length ?? 0);
	const unfinishedIn = (f: FolderChild) => pending?.children[f.id] ?? 0;
	const [err, setErr] = useState<string | null>(null);
	const current = data?.path.at(-1);
	useDocumentTitle(folderId === "root" ? t.folders.title : current?.name);
	const [type, setType] = useTypeFilter();
	const [person, setPerson] = usePersonFilter();
	const { data: personData } = useQuery({ ...personQuery(person ?? ""), enabled: !!person });
	const view = useFolderView();
	// 列表视图的接口多带文件名、大小和时间（都是 assets 自己的列），单独缓存；幻灯片和列表共用同一个 source，不会多请求。
	// 按人物筛选走单独的路径（ETag 同时带上人物的版本）
	const assetsPath = withType(person ? `/folders/${folderId}/people/${person}/assets` : `/folders/${folderId}/assets`, type);
	const source: ListSource =
		view === "list"
			? { key: ["folder", folderId, type, person, "list"], path: `${assetsPath}${type ? "&" : "?"}view=list` }
			: { key: ["folder", folderId, type, person], path: assetsPath };

	const mutate = async (fn: () => Promise<unknown>) => {
		setErr(null);
		try {
			await fn();
			invalidateLibrary(qc);
		} catch (e) {
			setErr(errorText(e));
		}
	};
	const create = async () => {
		const name = await promptDialog({ title: t.folders.newFolder, placeholder: t.folders.folderName, confirmLabel: t.common.create });
		if (name) void mutate(() => api("/folders", { method: "POST", json: { name, parentId: current?.id ?? null } }));
	};
	const renameFolder = async (f: { id: string; name: string }) => {
		const name = await promptDialog({ title: t.folders.renameFolder, defaultValue: f.name, confirmLabel: t.common.rename });
		if (name && name !== f.name) void mutate(() => api(`/folders/${f.id}`, { method: "PATCH", json: { name } }));
	};
	const removeFolder = async (f: { id: string; name: string }, after?: () => void) => {
		if (!(await confirmDialog({ title: t.folders.deleteTitle(f.name), confirmLabel: t.actions.delete, danger: true }))) return;
		void mutate(async () => {
			await api(`/folders/${f.id}`, { method: "DELETE" });
			after?.();
		});
	};
	const rename = () => current && void renameFolder(current);
	const remove = () =>
		current &&
		void removeFolder(current, () => {
			const parent = data!.path.at(-2)?.id ?? "root";
			void navigate({ to: "/folders/$folderId", params: { folderId: parent } });
		});
	const [moving, setMoving] = useState<FolderChild | null>(null);
	const folderMenu = (e: React.MouseEvent, f: FolderChild) =>
		openContextMenu(e, [
			{ label: t.library.open, icon: <IconFolder size={18} />, onSelect: () => void navigate({ to: "/folders/$folderId", params: { folderId: f.id } }) },
			...uploadMenuItems(f.id, "here"),
			"sep",
			{ label: t.common.renameMenu, icon: <IconEdit size={18} />, onSelect: () => void renameFolder(f) },
			{ label: t.folders.moveMenu, icon: <IconFolderMove size={18} />, onSelect: () => setMoving(f) },
			"sep",
			f.count || unfinishedIn(f) || f.subfolders
				? { label: t.folders.deleteOnlyEmpty, icon: <IconTrash size={18} />, danger: true, disabled: true, onSelect: () => {} }
				: { label: t.actions.delete, icon: <IconTrash size={18} />, danger: true, onSelect: () => void removeFolder(f) },
		]);

	if (error) return <p className="text-danger">{errorText(error)}</p>;
	return (
		<div className="space-y-6">
			<div className="flex items-center gap-2 pt-1">
				{/* 路径始终一行：上级文件夹限宽截断，当前文件夹占剩下的宽度；手机上只显示上一级，更上面的折叠成“…” */}
				<nav className="flex min-w-0 flex-1 items-center gap-1 text-xl font-bold tracking-tight sm:text-2xl" aria-label={t.folders.path}>
					<Link to="/folders/$folderId" params={{ folderId: "root" }} className={`shrink-0 ${current ? "text-muted hover:text-fg" : ""}`}>
						{t.folders.title}
					</Link>
					{data && data.path.length > 2 && (
						<span className="flex shrink-0 items-center gap-1 text-muted sm:hidden" aria-hidden>
							<IconChevronRight size={18} className="shrink-0" />…
						</span>
					)}
					{data?.path.map((p, i) => {
						const last = i === data.path.length - 1;
						return (
							<span
								key={p.id}
								className={`min-w-0 items-center gap-1 ${i < data.path.length - 2 ? "hidden sm:flex" : "flex"} ${last ? "flex-1" : "max-w-[40%] sm:max-w-56"}`}
							>
								<IconChevronRight size={20} className="shrink-0 text-muted" />
								<Link to="/folders/$folderId" params={{ folderId: p.id }} title={p.name} className={`truncate ${last ? "" : "text-muted hover:text-fg"}`}>
									{p.name}
								</Link>
							</span>
						);
					})}
				</nav>
				<ViewToggle view={view} />
				<SlideshowButton key={`${folderId}:${type}:${person}:${view}`} source={source} />
				{/* 上传在顶栏的“上传”里（在文件夹页面会传到这个文件夹），这里不重复 */}
				<PageActions
					actions={[{ label: t.folders.newFolder, icon: <IconPlus size={18} />, onSelect: create }]}
					menu={
						current
							? [
									{ label: t.folders.renameFolder, icon: <IconEdit size={18} />, onSelect: rename },
									{ label: t.folders.deleteFolder, icon: <IconTrash size={18} />, danger: true, onSelect: remove },
								]
							: []
					}
				/>
			</div>
			<FolderPeople folderId={folderId} value={person} onChange={setPerson} />
			<TypeFilter value={type} onChange={setType} />
			{err && <p className="text-sm text-danger">{err}</p>}
			{/* 子文件夹的骨架只在根目录显示：下层大多没有子文件夹，先画出卡片再消失反而跳一下（照片网格有自己的骨架） */}
			{!data && folderId === "root" && (view === "list" ? <FolderRowsSkeleton /> : <FolderCardsSkeleton />)}
			{!!data?.children.length && view === "list" && <FolderRows folders={data.children} unfinishedIn={unfinishedIn} onMenu={folderMenu} />}
			{!!data?.children.length && view === "grid" && (
				<ul className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
					{data.children.map((f) => (
						<li key={f.id}>
							<Link to="/folders/$folderId" params={{ folderId: f.id }} className="block space-y-1.5" onContextMenu={(e) => folderMenu(e, f)}>
								<FolderCover covers={f.covers} />
								<div className="truncate text-sm font-semibold">{f.name}</div>
								<div className="text-xs text-muted">
									{t.common.items(f.count)}
									{unfinishedIn(f) ? t.folders.unfinishedTag(unfinishedIn(f)) : ""}
									{f.subfolders ? t.folders.subfoldersTag(f.subfolders) : ""}
								</div>
							</Link>
						</li>
					))}
				</ul>
			)}
			{moving && (
				<FolderPicker
					title={t.folders.moveTitle(moving.name)}
					initial={current?.id ?? null}
					onClose={() => setMoving(null)}
					onPick={(parentId) => {
						const f = moving;
						setMoving(null);
						void mutate(() => api(`/folders/${f.id}`, { method: "PATCH", json: { parentId } }));
					}}
				/>
			)}
			{!!pending?.items.length && <UnfinishedNotice items={pending.items} />}
			<LibraryList
				key={`${folderId}:${type}:${person}:${view}`}
				source={source}
				view={view}
				datedScrubber
				// 按人物筛选时，选中照片的操作和人物页一样（“这不是 X”“这是其他人物”），直接改认错的脸
				context={person ? { kind: "person", personId: person, name: personData?.name ?? null } : { kind: "library" }}
				// 有子文件夹时不提示，只有整个目录都是空的才说“空目录”
				empty={person ? t.people.empty : type ? t.folders.emptyType : data?.children.length ? null : t.folders.emptyDir}
			/>
		</div>
	);
}

/**
 * 文件夹里还有正在处理的项：触发资料库同步（library/sync.ts），处理完时文件夹和列表会自己刷新。
 * 次数上限和费用都由同步器负责。
 */
function useProcessingRefresh(processing: number) {
	useEffect(() => {
		if (processing > 0) armLibrarySync();
	}, [processing]);
}

/** 列表只显示处理好的照片；还没处理完的在这里说明，失败和上传中断的可以移到回收站。 */
function UnfinishedNotice({ items }: { items: UnfinishedAsset[] }) {
	const qc = useQueryClient();
	const count = (state: UnfinishedAsset["state"]) => items.filter((i) => i.state === state).length;
	const processing = count("processing");
	const failed = count("failed");
	const abandoned = count("abandoned");
	const removable = items.filter((i) => i.state !== "processing").map((i) => i.id);
	const trash = useMutation({ mutationFn: () => batch(qc, removable, { action: "trash" }) });
	const confirmTrash = async () => {
		const ok = await confirmDialog({
			title: t.unfinished.trashTitle(removable.length),
			message: t.unfinished.trashMessage,
			confirmLabel: t.actions.moveToTrash,
			danger: true,
		});
		if (ok) trash.mutate();
	};
	const [showFiles, setShowFiles] = useState(false);
	const listed = items.filter((i) => i.state !== "processing");
	const parts = [
		processing && t.unfinished.processing(processing),
		failed && t.unfinished.failed(failed),
		abandoned && t.unfinished.abandoned(abandoned),
	].filter((p): p is string => !!p);
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-surface px-4 py-3 text-sm">
			<IconInfo size={18} className="shrink-0 text-muted" />
			<p className="min-w-0 flex-1">
				{t.unfinished.summary(items.length >= 1000 ? "1000+" : String(items.length), parts)}
				{processing > 0 && (
					<>
						{" "}
						<Link to="/settings/processing" className="text-accent underline">
							{t.unfinished.viewProgress}
						</Link>
					</>
				)}
				{failed > 0 && (
					<>
						{" "}
						{t.unfinished.retryBefore}
						<Link to="/settings/processing" className="text-accent underline">
							{t.unfinished.retryLink}
						</Link>
						{t.unfinished.retryAfter}
					</>
				)}
			</p>
			{listed.length > 0 && (
				<button className="btn" aria-expanded={showFiles} onClick={() => setShowFiles((v) => !v)}>
					{showFiles ? t.unfinished.hideFiles : t.unfinished.showFiles}
				</button>
			)}
			{removable.length > 0 && (
				<button className="btn" disabled={trash.isPending} onClick={() => void confirmTrash()}>
					<IconTrash size={18} />
					{t.unfinished.trashRemovable}
				</button>
			)}
			{trash.error && <p className="w-full text-danger">{errorText(trash.error)}</p>}
			{showFiles && <UnfinishedFiles items={listed} />}
		</div>
	);
}

function UnfinishedFiles({ items }: { items: UnfinishedAsset[] }) {
	const [copied, setCopied] = useState(false);
	const abandoned = items.filter((i) => i.state === "abandoned");
	const failed = items.filter((i) => i.state === "failed");
	const names = (list: UnfinishedAsset[]) => list.flatMap((i) => (i.names.length ? i.names : [t.unfinished.noName]));
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(names(items).join("\n"));
			setCopied(true);
		} catch {
			// 没有剪贴板权限时什么都不做
		}
	};
	const group = (title: string, list: UnfinishedAsset[]) =>
		list.length > 0 && (
			<div>
				<div className="mb-1 font-semibold">
					{t.unfinished.groupTitle(title, list.length)}
				</div>
				<ul className="max-h-60 overflow-y-auto rounded-lg bg-card px-3 py-2 font-mono text-xs leading-6">
					{list.map((i) => (
						<li key={i.id} className="truncate">
							{i.names.length ? i.names.join("  ·  ") : <span className="text-muted">{t.unfinished.noName}</span>}
						</li>
					))}
				</ul>
			</div>
		);
	return (
		<div className="w-full space-y-3 border-t border-border pt-3">
			{abandoned.length > 0 && (
				<p className="text-muted">
					{t.unfinished.reuploadHint}
				</p>
			)}
			{group(t.unfinished.abandonedTitle, abandoned)}
			{group(t.unfinished.failedTitle, failed)}
			<button className="btn" onClick={() => void copy()}>
				{copied ? t.unfinished.copied : t.unfinished.copyAll}
			</button>
		</div>
	);
}

// ------------------------------------------------------------------ 相册

export function AlbumsPage() {
	useDocumentTitle(t.albums.title);
	const { data } = useQuery(albumsQuery);
	const create = useCreateAlbum();
	return (
		<div className="space-y-6">
			<div className="flex items-center gap-2 pt-1">
				<h1 className="page-title flex-1">{t.albums.title}</h1>
				<button className="btn" onClick={create}>
					<IconPlus size={18} />
					{t.albums.newAlbum}
				</button>
			</div>
			<section className="space-y-3">
				<h2 className="text-lg font-bold">{t.albums.title}</h2>
				{data?.length === 0 && (
					<p className="py-12 text-center text-sm text-muted">{t.albums.none}</p>
				)}
				{data ? <AlbumGrid albums={data} /> : <AlbumCardsSkeleton />}
			</section>
		</div>
	);
}

export function useCreateAlbum() {
	const qc = useQueryClient();
	const create = useMutation({
		mutationFn: (name: string) => api<{ id: string }>("/albums", { method: "POST", json: { name } }),
		onSuccess: () => invalidateLibrary(qc),
	});
	return async () => {
		const name = await promptDialog({ title: t.albums.newAlbum, placeholder: t.albums.albumName, confirmLabel: t.common.create });
		if (name) create.mutate(name, { onError: (e) => void alertDialog(t.albums.createFailed, errorText(e)) });
	};
}

export function AlbumGrid({ albums }: { albums: AlbumSummary[] | undefined }) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const act = async (fn: () => Promise<unknown>) => {
		try {
			await fn();
			invalidateLibrary(qc);
		} catch (e) {
			void alertDialog(t.common.actionFailed, errorText(e));
		}
	};
	const menu = (e: React.MouseEvent, a: AlbumSummary) =>
		openContextMenu(e, [
			{ label: t.library.open, icon: <IconAlbum size={18} />, onSelect: () => void navigate({ to: "/albums/$albumId", params: { albumId: a.id } }) },
			{
				label: t.common.renameMenu,
				icon: <IconEdit size={18} />,
				onSelect: async () => {
					const name = await promptDialog({ title: t.albums.renameAlbum, defaultValue: a.name, confirmLabel: t.common.rename });
					if (name && name !== a.name) void act(() => api(`/albums/${a.id}`, { method: "PATCH", json: { name } }));
				},
			},
			"sep",
			{
				label: t.albums.deleteAlbum,
				icon: <IconTrash size={18} />,
				danger: true,
				onSelect: () =>
					void confirmAlbumDelete(a.name).then((ok) => (ok ? act(() => api(`/albums/${a.id}`, { method: "DELETE" })) : undefined)),
			},
		]);
	return (
		<ul className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
			{albums?.map((a) => (
				<li key={a.id}>
					<Link
						to="/albums/$albumId"
						params={{ albumId: a.id }}
						className="group/card block rounded-3xl border border-border bg-card p-2 transition hover:bg-surface"
						onContextMenu={(e) => menu(e, a)}
					>
						<AlbumMosaic cover={a.cover} samples={a.samples} />
						<div className="flex items-baseline gap-3 px-2 pt-2.5 pb-1">
							<div className="min-w-0 flex-1 truncate text-base font-semibold">{a.name}</div>
							<div className="shrink-0 text-xs text-muted">{albumCount(a)}</div>
						</div>
					</Link>
				</li>
			))}
		</ul>
	);
}

function albumCount({ photos, videos }: AlbumSummary) {
	if (!photos && !videos) return t.albums.emptyCover;
	return [photos && t.albums.photos(photos), videos && t.albums.videos(videos)].filter(Boolean).join(" · ");
}

const ALBUM_SAMPLES = 9;

/**
 * 相册卡片：左边一半是封面，右边 3×3 是相册里“随机”的 9 张（服务端按固定的伪随机顺序给出，去掉封面）。
 * 张数不够时空格只留底色。和文件夹封面一样，离视口 600px 以外就卸载图片。
 */
function AlbumMosaic({ cover, samples }: { cover: string | null; samples: string[] }) {
	const ref = useRef<HTMLDivElement>(null);
	const near = useNear(ref);
	const coverId = cover?.split(":")[0];
	const rest = samples.filter((s) => s.split(":")[0] !== coverId).slice(0, ALBUM_SAMPLES);
	const cells = Array.from({ length: ALBUM_SAMPLES }, (_, i) => rest[i] ?? null);
	const img = (c: string) => (
		<img
			src={coverUrl(c) ?? undefined}
			alt=""
			className="h-full w-full object-cover"
			onError={(e) => (e.currentTarget.style.visibility = "hidden")}
		/>
	);
	return (
		<div ref={ref} className="grid aspect-[2/1] grid-cols-6 grid-rows-3 gap-0.5 overflow-hidden rounded-2xl">
			<div className="col-span-3 row-span-3 overflow-hidden bg-surface">
				{cover ? (
					near && <div className="h-full w-full transition duration-300 group-hover/card:scale-[1.03]">{img(cover)}</div>
				) : (
					<div className="flex h-full items-center justify-center text-muted" aria-label={t.albums.emptyCover}>
						<IconAlbum size={36} />
					</div>
				)}
			</div>
			{cells.map((c, i) => (
				<div key={c ?? `empty-${i}`} className="min-h-0 overflow-hidden bg-surface">
					{c && near && img(c)}
				</div>
			))}
		</div>
	);
}

export function AlbumPage() {
	const { albumId } = useParams({ strict: false }) as { albumId: string };
	const qc = useQueryClient();
	const navigate = useNavigate();
	const [type, setType] = useTypeFilter();
	const source: ListSource = { key: ["album", albumId, type], path: withType(`/albums/${albumId}/assets`, type) };
	const album = useQuery({ queryKey: ["albums", albumId], queryFn: () => api<{ id: string; name: string }>(`/albums/${albumId}`) });
	useDocumentTitle(album.data?.name);
	const rename = async () => {
		const name = await promptDialog({ title: t.albums.renameAlbum, defaultValue: album.data?.name, confirmLabel: t.common.rename });
		if (!name || name === album.data?.name) return;
		try {
			await api(`/albums/${albumId}`, { method: "PATCH", json: { name } });
			invalidateLibrary(qc);
		} catch (e) {
			void alertDialog(t.albums.renameFailed, errorText(e));
		}
	};
	const remove = async () => {
		if (!(await confirmAlbumDelete(album.data?.name ?? ""))) return;
		await api(`/albums/${albumId}`, { method: "DELETE" });
		invalidateLibrary(qc);
		void navigate({ to: "/albums" });
	};
	if (album.error) return <p className="text-danger">{errorText(album.error)}</p>;
	return (
		<div className="space-y-6">
			<div className="flex items-center gap-2 pt-1">
				<div className="flex min-w-0 flex-1 items-center gap-1 text-xl font-bold tracking-tight sm:text-2xl">
					<Link to="/albums" className="shrink-0 text-muted hover:text-fg">
						{t.albums.title}
					</Link>
					<IconChevronRight size={20} className="shrink-0 text-muted" />
					<h1 className="truncate" title={album.data?.name}>
						{album.data?.name}
					</h1>
				</div>
				<SlideshowButton key={`${albumId}:${type}`} source={source} />
				<PageActions
					menu={[
						{ label: t.albums.renameAlbum, icon: <IconEdit size={18} />, onSelect: () => void rename() },
						{ label: t.albums.deleteAlbum, icon: <IconTrash size={18} />, danger: true, onSelect: () => void remove() },
					]}
				/>
			</div>
			<TypeFilter value={type} onChange={setType} />
			<LibraryList
				key={`${albumId}:${type}`}
				source={source}
				datedScrubber
				context={{ kind: "album", albumId }}
				empty={type ? t.albums.emptyType : t.albums.empty}
			/>
		</div>
	);
}

// ------------------------------------------------------------------ 收藏 / 回收站

export function FavoritesPage() {
	useDocumentTitle(t.favorites.title);
	return (
		<div className="space-y-6">
			<h1 className="page-title pt-1">{t.favorites.title}</h1>
			<LibraryList source={{ key: ["favorites"], path: "/favorites/assets" }} context={{ kind: "library" }} empty={t.favorites.empty} />
		</div>
	);
}

export function TrashPage() {
	useDocumentTitle(t.trash.title);
	const qc = useQueryClient();
	const [busy, setBusy] = useState(false);
	const empty = async () => {
		if (!(await confirmDialog({ title: t.trash.emptyTitle, message: t.trash.emptyMessage, confirmLabel: t.actions.deleteForever, danger: true })))
			return;
		setBusy(true);
		try {
			// 每次最多删 1000 个，最多循环 500 次（50 万张）
			for (let i = 0; i < 500; i++) {
				const r = await api<{ remaining: number }>("/trash/empty", { method: "POST" });
				if (r.remaining === 0) break;
			}
		} finally {
			invalidateLibrary(qc);
			setBusy(false);
		}
	};
	return (
		<div className="space-y-5">
			<div className="flex flex-wrap items-center gap-2 pt-1">
				<h1 className="page-title flex-1">{t.trash.title}</h1>
				<button className="btn btn-danger" disabled={busy} onClick={() => void empty()}>
					<IconTrash size={18} />
					{t.trash.emptyTrash}
				</button>
			</div>
			<p className="flex items-start gap-2.5 rounded-2xl bg-notice px-4 py-3 text-sm">
				<IconInfo size={18} className="mt-0.5 shrink-0 text-muted" />
				{t.trash.notice}
			</p>
			<LibraryList
				source={{ key: ["trash"], path: "/trash/assets" }}
				context={{ kind: "trash" }}
				groupByDay={false}
				empty={t.trash.empty}
			/>
		</div>
	);
}
