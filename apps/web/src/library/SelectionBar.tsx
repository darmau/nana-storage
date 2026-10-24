import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { containerCost, type GuardStatus } from "@nana/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, errorText } from "../api";
import { t } from "../i18n";
import { confirmDialog } from "../ui/confirm";
import { type MenuItem, openMenuAt } from "../ui/ContextMenu";
import {
	IconAlbum,
	IconArchive,
	IconCheck,
	IconClose,
	IconCompress,
	IconDownload,
	IconEdit,
	IconFolderMove,
	IconHeart,
	IconMinus,
	IconMore,
	IconPeople,
	IconPhotos,
	IconRestore,
	IconSimilar,
	IconTrash,
} from "../ui/icons";
import { addToAlbum, batch, compressOriginals, createSmartSet, downloadZip, invalidateLibrary, removeFromAlbum, setSmartSetExamples } from "./actions";
import { BatchMetaEditor } from "./BatchMetaEditor";
import { AlbumPicker, FolderPicker, SmartSetPicker } from "./Pickers";
import { MAX_SELECTION, useSelection } from "./selection";
import { reassignPerson, removeFromPerson } from "../people/model";
import { PersonPicker } from "../people/PersonPicker";

export type BarContext =
	/** withArchived：列表里可能有归档的照片（文件夹页勾选了“显示归档照片”），归档和取消归档都提供 */
	| { kind: "library"; withArchived?: boolean }
	| { kind: "album"; albumId: string; withArchived?: boolean }
	/** 归档页：只提供“取消归档” */
	| { kind: "archive" }
	/** 人物页面：可以“从此人物中移除” */
	| { kind: "person"; personId: string; name: string | null }
	| { kind: "trash" }
	/** 主题的“样本”（设为正例 / 反例、移出样本）和“判断”（是 / 否）两个标签 */
	| { kind: "smartSet"; setId: string; view: "samples" | "review" }
	/** 主题的“结果”：和资料库一样的操作（主要是加入相册），另外可以标成“不属于这个主题” */
	| { kind: "topicResults"; setId: string }
	/** 整理 › 原图压缩的候选：主要操作是“压缩原图”，另外可以下载、删除 */
	| { kind: "compress" };

/** 加入主题样本后的提示：其中和分类器矛盾的张数。 */
const samplesText = (label: 1 | -1) => (r: { conflicts: number }) => t.actions.addedSamples(label, r.conflicts);
const createdText = (r: { suggestions: number }) => t.actions.createdTopic(r.suggestions);

/** 这个列表里提供哪些归档操作：归档页只能取消归档，显示了归档照片的列表两种都有，其余只能归档。 */
const archiveModes = (context: BarContext): boolean[] =>
	context.kind === "archive" ? [false] : "withArchived" in context && context.withArchived ? [true, false] : [true];

/** 先确认再执行 */
const confirmTrash = (n: number, fn: () => unknown) =>
	void confirmDialog({ title: t.actions.trashTitle(n), message: t.actions.trashMessage, confirmLabel: t.actions.delete, danger: true }).then((ok) => {
		if (ok) void fn();
	});
const confirmDeleteForever = (n: number, fn: () => unknown) =>
	void confirmDialog({
		title: t.actions.deleteForeverTitle(n),
		message: t.actions.deleteForeverMessage,
		confirmLabel: t.actions.deleteForever,
		danger: true,
	}).then((ok) => {
		if (ok) void fn();
	});

/** 估算用：一张大 JPEG 的容器秒数（解码 + 编码 + 校验，几千万像素的约 10–30 秒）。只用来提醒，不限制。 */
const COMPRESS_ESTIMATE_SECONDS = 15;

/**
 * 原图压缩会替换原图，先确认。顺带提醒云端处理的时间和费用（和上传面板的估算同一个算法，扣掉本月剩下的免费额度）；
 * 设备端接管时由设备处理，不产生容器费用。成本防护只读一次（打开确认框时）。
 */
async function confirmCompress(qc: QueryClient, n: number, fn: () => unknown) {
	const guard = await qc.fetchQuery({ queryKey: ["guard"], queryFn: () => api<GuardStatus>("/guard"), staleTime: 30_000 }).catch(() => null);
	const seconds = n * COMPRESS_ESTIMATE_SECONDS;
	let cost = "";
	if (guard?.device) cost = t.compress.onDevice;
	else if (guard) {
		const usd = containerCost(guard.month.containerSeconds + seconds) - containerCost(guard.month.containerSeconds);
		cost = t.compress.estimate(Math.max(1, Math.round(seconds / 60)), usd <= 0 ? "$0" : usd < 0.01 ? "< $0.01" : `$${usd.toFixed(2)}`);
	}
	const ok = await confirmDialog({
		title: t.compress.confirmTitle(n),
		message: `${t.compress.confirmMessage}${cost ? ` ${cost}` : ""}`,
		confirmLabel: t.compress.action,
		danger: true,
	});
	if (ok) void fn();
}
const compressDone = (r: { queued: number; skipped: number }) => t.compress.queuedDone(r.queued, r.skipped);

/**
 * 照片的操作（收藏、加入相册、移动、下载、删除 …）。多选操作栏和右键菜单共用，
 * 选相册 / 文件夹的弹窗和结果提示也放在这里，菜单关掉以后它们还在。
 */
interface Actions {
	context: BarContext;
	busy: boolean;
	/** done 可以是固定的提示，也可以根据 fn 的结果生成 */
	run: <T>(fn: () => Promise<T>, done?: string | ((r: T) => string), keepSelection?: boolean) => Promise<void>;
	pick: (kind: DialogKind, ids: string[]) => void;
	download: (ids: string[]) => void;
}

type DialogKind = "album" | "folder" | "meta" | "smartSet" | "person";

const Ctx = createContext<Actions | null>(null);

export function useAssetActions(): Actions {
	const a = useContext(Ctx);
	if (!a) throw new Error("useAssetActions outside AssetActionsProvider");
	return a;
}

/** 放在 SelectionProvider 里面，包住网格和 <SelectionBar />。 */
export function AssetActionsProvider({ context, children }: { context: BarContext; children: React.ReactNode }) {
	const qc = useQueryClient();
	const { clear } = useSelection();
	const [busy, setBusy] = useState(false);
	const [dialog, setDialog] = useState<{ kind: DialogKind; ids: string[] } | null>(null);
	const [message, setMessage] = useState<string | null>(null);

	useEffect(() => {
		if (!message) return;
		const timer = setTimeout(() => setMessage(null), 4000);
		return () => clearTimeout(timer);
	}, [message]);

	const run = useCallback(
		async <T,>(fn: () => Promise<T>, done?: string | ((r: T) => string), keepSelection = false) => {
			setBusy(true);
			setMessage(null);
			try {
				const r = await fn();
				if (done) setMessage(typeof done === "string" ? done : done(r));
				if (!keepSelection) clear();
			} catch (e) {
				setMessage(t.actions.failed(errorText(e)));
			} finally {
				setBusy(false);
			}
		},
		[clear],
	);
	const pick = useCallback((kind: DialogKind, ids: string[]) => setDialog({ kind, ids }), []);
	const download = useCallback(
		(ids: string[]) =>
			void run(
				async () => {
					const r = await downloadZip(ids);
					setMessage(t.actions.downloading(r.files, r.skipped));
				},
				undefined,
				true,
			),
		[run],
	);
	// 页面每次渲染都会传一个新的 context 对象，按内容固定下来，免得所有格子跟着重渲染
	const scopeId =
		(context.kind === "album" ? context.albumId : context.kind === "person" ? `${context.personId}:${context.name ?? ""}` : "") +
		("withArchived" in context && context.withArchived ? ":archived" : "");
	const setKey = context.kind === "smartSet" ? `${context.setId}:${context.view}` : context.kind === "topicResults" ? context.setId : "";
	const ctx = useMemo(() => context, [context.kind, scopeId, setKey]);
	const value = useMemo(() => ({ context: ctx, busy, run, pick, download }), [ctx, busy, run, pick, download]);

	return (
		<Ctx.Provider value={value}>
			{children}
			{message && (
				<p
					role="status"
					className="fixed bottom-[calc(var(--tabbar-h)+5rem)] left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 pop-in rounded-full bg-fg px-4 py-2 text-sm text-bg shadow-lg sm:bottom-24 md:left-[calc(50%+var(--sidebar-w)/2)]"
				>
					{message}
				</p>
			)}
			{dialog?.kind === "album" && (
				<AlbumPicker
					onClose={() => setDialog(null)}
					onPick={(albumId) => {
						setDialog(null);
						void run(() => addToAlbum(qc, albumId, dialog.ids), t.actions.addedToAlbum);
					}}
				/>
			)}
			{dialog?.kind === "folder" && (
				<FolderPicker
					onClose={() => setDialog(null)}
					onPick={(folderId) => {
						setDialog(null);
						void run(() => batch(qc, dialog.ids, { action: "move", folderId }), t.actions.moved);
					}}
				/>
			)}
			{dialog?.kind === "smartSet" && (
				<SmartSetPicker
					onClose={() => setDialog(null)}
					onPick={(pick) => {
						setDialog(null);
						if ("create" in pick) void run(() => createSmartSet(qc, pick.create, dialog.ids), createdText);
						else void run(() => setSmartSetExamples(qc, pick.setId, dialog.ids, pick.label), samplesText(pick.label));
					}}
				/>
			)}
			{dialog?.kind === "person" && ctx.kind === "person" && (
				<PersonPicker
					title={t.actions.whoIsThis}
					allowNew
					exclude={[ctx.personId]}
					onClose={() => setDialog(null)}
					onPick={(pick) => {
						setDialog(null);
						void run(
							() => reassignPerson(qc, ctx.personId, dialog.ids, "person" in pick ? { personId: pick.person.id } : { name: pick.name }),
							t.actions.reassigned,
						);
					}}
				/>
			)}
			{dialog?.kind === "meta" && (
				<BatchMetaEditor
					count={dialog.ids.length}
					onClose={() => setDialog(null)}
					onApply={(action, done) => {
						setDialog(null);
						// 保留选择，方便接着改另一项
						void run(() => batch(qc, dialog.ids, action), done, true);
					}}
				/>
			)}
		</Ctx.Provider>
	);
}

/**
 * 右键菜单里的照片操作。右键的是已选中的照片时，对所有选中的照片操作；否则只对这一张。
 * favorite 是右键那张照片的收藏状态（只有单张时用来决定显示“收藏”还是“取消收藏”）。
 */
export function useAssetMenu() {
	const qc = useQueryClient();
	const { selected, toggle } = useSelection();
	const { context, run, pick, download } = useAssetActions();

	/** group：连拍封面代表的整组，没有选中别的照片时，操作作用于整组。 */
	return (id: string, favorite: boolean, onOpen: (id: string) => void, group?: string[]): MenuItem[] => {
		const multi = selected.has(id) && selected.size > (group?.length ?? 1);
		const ids = multi ? [...selected] : (group ?? [id]);
		const head: MenuItem[] = multi
			? [{ heading: t.actions.selected(ids.length) }]
			: [
					{ label: t.library.open, icon: <IconPhotos size={18} />, onSelect: () => onOpen(id) },
					{ label: selected.has(id) ? t.library.deselect : t.library.select, icon: <IconCheck size={18} />, onSelect: () => toggle(id, undefined, group) },
				];
		if (group && !multi) head.splice(0, 0, { heading: t.actions.burst(group.length) });

		if (context.kind === "smartSet")
			return [...head, "sep", ...smartSetItems(context, (label) => run(() => setSmartSetExamples(qc, context.setId, ids, label), sampleDone(label)))];

		if (context.kind === "person") {
			const { personId } = context;
			const items: MenuItem[] = [...head, "sep"];
			if (!multi && !group)
				items.push({
					label: t.actions.setPersonCover,
					icon: <IconPeople size={18} />,
					onSelect: () =>
						void run(
							async () => {
								await api(`/people/${personId}`, { method: "PATCH", json: { coverAssetId: id } });
								invalidateLibrary(qc);
							},
							t.actions.coverSet,
							true,
						),
				});
			return [...items, ...personItems(context, () => void run(() => removeFromPerson(qc, personId, ids)), () => pick("person", ids))];
		}

		if (context.kind === "compress") {
			return [
				...head,
				"sep",
				{ label: t.compress.action, icon: <IconCompress size={18} />, onSelect: () => void confirmCompress(qc, ids.length, () => run(() => compressOriginals(qc, ids), compressDone)) },
				{ label: multi ? t.actions.download : t.actions.downloadOriginal, icon: <IconDownload size={18} />, onSelect: () => download(ids) },
				"sep",
				{
					label: t.actions.delete,
					icon: <IconTrash size={18} />,
					danger: true,
					onSelect: () => confirmTrash(ids.length, () => run(() => batch(qc, ids, { action: "trash" }))),
				},
			];
		}

		if (context.kind === "trash") {
			return [
				...head,
				"sep",
				{ label: t.actions.restore, icon: <IconRestore size={18} />, onSelect: () => void run(() => batch(qc, ids, { action: "restore" })) },
				{
					label: t.actions.deleteForever,
					icon: <IconTrash size={18} />,
					danger: true,
					onSelect: () => confirmDeleteForever(ids.length, () => run(() => batch(qc, ids, { action: "delete-forever" }))),
				},
			];
		}

		const unfavorite = !multi && favorite;
		const items: MenuItem[] = [
			...head,
			"sep",
			{
				label: unfavorite ? t.actions.unfavorite : t.actions.favorite,
				icon: <IconHeart size={18} filled={unfavorite} />,
				onSelect: () => void run(() => batch(qc, ids, { action: "favorite", value: !unfavorite }), undefined, !multi),
			},
			...archiveModes(context).map(
				(value): MenuItem => ({
					label: value ? t.actions.archive : t.actions.unarchive,
					icon: <IconArchive size={18} />,
					onSelect: () => void run(() => batch(qc, ids, { action: "archive", value }), value ? t.actions.archived : t.actions.unarchived),
				}),
			),
			{ label: t.actions.addToAlbumMenu, icon: <IconAlbum size={18} />, onSelect: () => pick("album", ids) },
			{ label: t.actions.moveToFolderMenu, icon: <IconFolderMove size={18} />, onSelect: () => pick("folder", ids) },
			{ label: t.actions.addToTopicMenu, icon: <IconSimilar size={18} />, onSelect: () => pick("smartSet", ids) },
			{ label: t.actions.editMetaMenu, icon: <IconEdit size={18} />, onSelect: () => pick("meta", ids) },
			{ label: multi ? t.actions.download : t.actions.downloadOriginal, icon: <IconDownload size={18} />, onSelect: () => download(ids) },
		];
		if (context.kind === "album") {
			const { albumId } = context;
			if (!multi && !group)
				items.push({
					label: t.actions.setAlbumCover,
					icon: <IconAlbum size={18} />,
					onSelect: () =>
						void run(
							async () => {
								await api(`/albums/${albumId}`, { method: "PATCH", json: { coverAssetId: id } });
								invalidateLibrary(qc);
							},
							t.actions.coverSet,
							true,
						),
				});
			items.push({ label: t.actions.removeFromAlbum, icon: <IconClose size={18} />, onSelect: () => void run(() => removeFromAlbum(qc, albumId, ids)) });
		}
		if (context.kind === "topicResults") {
			const { setId } = context;
			items.push({ label: t.actions.notInTopic, icon: <IconClose size={18} />, onSelect: () => void run(() => setSmartSetExamples(qc, setId, ids, -1), t.actions.markedNegative) });
		}
		items.push("sep", {
			label: t.actions.delete,
			icon: <IconTrash size={18} />,
			danger: true,
			onSelect: () => confirmTrash(ids.length, () => run(() => batch(qc, ids, { action: "trash" }))),
		});
		return items;
	};
}

/** 多选时出现在底部的操作栏。 */
export function SelectionBar() {
	const qc = useQueryClient();
	const { selected, clear } = useSelection();
	const { context, busy, run, pick, download } = useAssetActions();
	if (!selected.size) return null;
	const ids = [...selected];

	// 移动端：贴底、盖住底部导航，只显示图标（文字留给读屏）；桌面：浮在内容区底部中间的胶囊
	const btn =
		"inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 text-sm font-medium hover:bg-surface disabled:opacity-50 sm:px-3.5";
	const label = "sr-only sm:not-sr-only";
	// 手机上一行放不下全部按钮：只留收藏、加入相册、下载、删除，其余收进“更多”
	const desktopOnly = "max-sm:hidden";
	const archive = archiveModes(context).map((value) => ({
		value,
		label: value ? t.actions.archive : t.actions.unarchive,
		onSelect: () => void run(() => batch(qc, ids, { action: "archive", value }), value ? t.actions.archived : t.actions.unarchived),
	}));
	// 归档页里“取消归档”是主要操作，手机上也直接显示
	const archiveInBar = context.kind === "archive";
	const more: MenuItem[] = [
		...(archiveInBar ? [] : archive.map((a) => ({ label: a.label, icon: <IconArchive size={18} />, onSelect: a.onSelect }))),
		{ label: t.actions.moveToFolder, icon: <IconFolderMove size={18} />, onSelect: () => pick("folder", ids) },
		{ label: t.actions.addToTopic, icon: <IconSimilar size={18} />, onSelect: () => pick("smartSet", ids) },
		{ label: t.actions.editMeta, icon: <IconEdit size={18} />, onSelect: () => pick("meta", ids) },
	];
	if (context.kind === "album")
		more.push({ label: t.actions.removeFromAlbum, icon: <IconClose size={18} />, onSelect: () => void run(() => removeFromAlbum(qc, context.albumId, ids)) });
	if (context.kind === "topicResults")
		more.push({ label: t.actions.notInTopic, icon: <IconClose size={18} />, onSelect: () => void run(() => setSmartSetExamples(qc, context.setId, ids, -1), t.actions.markedNegative) });
	return (
		<div
			role="toolbar"
			aria-label={t.actions.toolbar}
			className="bar-in fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card px-2 pb-[max(0.5rem,var(--safe-bottom))] pt-2 shadow-[0_-4px_24px_rgb(0_0_0/0.08)] sm:inset-x-auto sm:bottom-6 sm:left-1/2 sm:w-max sm:max-w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:rounded-full sm:border sm:pb-2 md:left-[calc(50%+var(--sidebar-w)/2)] md:max-w-[calc(100vw-var(--sidebar-w)-2rem)]"
		>
			<div className="flex items-center gap-0.5 overflow-x-auto">
				<button className={btn} onClick={clear} aria-label={t.library.deselect}>
					<IconClose />
				</button>
				<span className="mr-auto whitespace-nowrap pl-1 pr-3 text-sm font-semibold sm:mr-2">
					{selected.size >= MAX_SELECTION ? t.actions.selectedAtLimit(selected.size) : t.actions.selected(selected.size)}
				</span>
				{context.kind === "person" ? (
					personItems(
						context,
						() => void run(() => removeFromPerson(qc, context.personId, ids)),
						() => pick("person", ids),
					).map((it) => (
						<button key={it.label} className={btn} disabled={busy} onClick={it.onSelect}>
							{it.icon}
							<span>{it.label}</span>
						</button>
					))
				) : context.kind === "smartSet" ? (
					smartSetItems(context, (l) => run(() => setSmartSetExamples(qc, context.setId, ids, l), sampleDone(l))).map((it) => (
						<button key={it.label} className={btn} disabled={busy} onClick={it.onSelect}>
							{it.icon}
							<span>{it.label}</span>
						</button>
					))
				) : context.kind === "compress" ? (
					<>
						<button className={btn} disabled={busy} onClick={() => void confirmCompress(qc, ids.length, () => run(() => compressOriginals(qc, ids), compressDone))}>
							<IconCompress />
							<span>{t.compress.action}</span>
						</button>
						<button className={btn} disabled={busy} onClick={() => download(ids)}>
							<IconDownload />
							<span className={label}>{t.actions.download}</span>
						</button>
						<button
							className={`${btn} text-danger`}
							disabled={busy}
							onClick={() => confirmTrash(ids.length, () => run(() => batch(qc, ids, { action: "trash" })))}
						>
							<IconTrash />
							<span className={label}>{t.actions.delete}</span>
						</button>
					</>
				) : context.kind === "trash" ? (
					<>
						<button className={btn} disabled={busy} onClick={() => run(() => batch(qc, ids, { action: "restore" }))}>
							<IconRestore />
							<span className={label}>{t.actions.restore}</span>
						</button>
						<button
							className={`${btn} text-danger`}
							disabled={busy}
							onClick={() => confirmDeleteForever(ids.length, () => run(() => batch(qc, ids, { action: "delete-forever" })))}
						>
							<IconTrash />
							<span className={label}>{t.actions.deleteForever}</span>
						</button>
					</>
				) : (
					<>
						<button className={btn} disabled={busy} onClick={() => run(() => batch(qc, ids, { action: "favorite", value: true }))}>
							<IconHeart />
							<span className={label}>{t.actions.favorite}</span>
						</button>
						<button className={btn} disabled={busy} onClick={() => pick("album", ids)}>
							<IconAlbum />
							<span className={label}>{t.actions.addToAlbum}</span>
						</button>
						{archive.map((a) => (
							<button key={a.label} className={`${btn} ${archiveInBar ? "" : desktopOnly}`} disabled={busy} onClick={a.onSelect}>
								<IconArchive />
								<span className={label}>{a.label}</span>
							</button>
						))}
						<button className={`${btn} ${desktopOnly}`} disabled={busy} onClick={() => pick("folder", ids)}>
							<IconFolderMove />
							<span className={label}>{t.actions.move}</span>
						</button>
						<button className={`${btn} ${desktopOnly}`} disabled={busy} onClick={() => pick("smartSet", ids)}>
							<IconSimilar />
							<span className={label}>{t.actions.topic}</span>
						</button>
						<button className={`${btn} ${desktopOnly}`} disabled={busy} onClick={() => pick("meta", ids)}>
							<IconEdit />
							<span className={label}>{t.actions.timeAndPlace}</span>
						</button>
						<button className={btn} disabled={busy} onClick={() => download(ids)}>
							<IconDownload />
							<span className={label}>{t.actions.download}</span>
						</button>
						{context.kind === "album" && (
							<button className={`${btn} ${desktopOnly}`} disabled={busy} onClick={() => run(() => removeFromAlbum(qc, context.albumId, ids))}>
								<IconClose />
								<span className={label}>{t.actions.removeFromAlbum}</span>
							</button>
						)}
						{context.kind === "topicResults" && (
							<button
								className={`${btn} ${desktopOnly}`}
								disabled={busy}
								onClick={() => run(() => setSmartSetExamples(qc, context.setId, ids, -1), t.actions.markedNegative)}
							>
								<IconClose />
								<span className={label}>{t.actions.notInTopic}</span>
							</button>
						)}
						<button
							className={`${btn} text-danger`}
							disabled={busy}
							onClick={() => confirmTrash(ids.length, () => run(() => batch(qc, ids, { action: "trash" })))}
						>
							<IconTrash />
							<span className={label}>{t.actions.delete}</span>
						</button>
						<button className={`${btn} sm:hidden`} disabled={busy} aria-label={t.actions.more} onClick={(e) => openMenuAt(e.currentTarget, more)}>
							<IconMore />
						</button>
					</>
				)}
			</div>
		</div>
	);
}

/** 主题里标记之后的提示：移出样本没有提示，其余提示其中和分类器矛盾的张数。 */
const sampleDone = (label: 1 | -1 | 0) => (label === 0 ? undefined : samplesText(label));

/**
 * 主题页面里的操作：
 *  - 样本：设为正例、设为反例、移出样本（移出后就和普通照片一样，下次训练可能重新出现在建议里）；
 *  - 判断：建议里的照片“是 / 否”，分别记成正例 / 反例。
 */
function smartSetItems(
	context: Extract<BarContext, { kind: "smartSet" }>,
	set: (label: 1 | -1 | 0) => unknown,
): { label: string; icon: React.ReactNode; onSelect: () => void }[] {
	if (context.view === "review")
		return [
			{ label: t.actions.yes, icon: <IconCheck size={18} />, onSelect: () => void set(1) },
			{ label: t.actions.no, icon: <IconClose size={18} />, onSelect: () => void set(-1) },
		];
	return [
		{ label: t.actions.setPositive, icon: <IconCheck size={18} />, onSelect: () => void set(1) },
		{ label: t.actions.setNegative, icon: <IconClose size={18} />, onSelect: () => void set(-1) },
		{ label: t.actions.removeSample, icon: <IconMinus size={18} />, onSelect: () => void set(0) },
	];
}

/** 人物页里选中照片后的操作：只有“这不是 X”和“这是其他人物”。 */
function personItems(
	context: Extract<BarContext, { kind: "person" }>,
	notThisPerson: () => void,
	otherPerson: () => void,
): { label: string; icon: React.ReactNode; onSelect: () => void }[] {
	return [
		{ label: t.actions.notThisPerson(context.name), icon: <IconClose size={18} />, onSelect: notThisPerson },
		{ label: t.actions.otherPerson, icon: <IconPeople size={18} />, onSelect: otherPerson },
	];
}
