import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { invalidateLibrary } from "./actions";
import { Modal } from "./Modal";
import { albumsQuery, folderQuery, smartSetsQuery } from "./queries";
import { IconCheck, IconChevronLeft, IconChevronRight, IconClose, IconFolder } from "../ui/icons";
import { t } from "../i18n";
import { SMART_SET_MAX_FOLDERS } from "@nana/shared";

export function AlbumPicker({ onPick, onClose }: { onPick: (albumId: string) => void; onClose: () => void }) {
	const qc = useQueryClient();
	const { data } = useQuery(albumsQuery);
	const [name, setName] = useState("");
	const create = async () => {
		if (!name.trim()) return;
		const r = await api<{ id: string }>("/albums", { method: "POST", json: { name: name.trim() } });
		invalidateLibrary(qc);
		onPick(r.id);
	};
	return (
		<Modal title={t.pickers.addToAlbum} onClose={onClose}>
			<form
				className="mb-4 flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					void create();
				}}
			>
				<input
					className="flex-1 rounded-md border border-border bg-bg px-3 py-1.5 text-sm"
					placeholder={t.pickers.newAlbumName}
					value={name}
					onChange={(e) => setName(e.target.value)}
					maxLength={200}
				/>
				<button className="btn-primary" disabled={!name.trim()}>
					{t.pickers.createAndAdd}
				</button>
			</form>
			<ul className="space-y-1">
				{data?.map((a) => (
					<li key={a.id}>
						<button className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-surface" onClick={() => onPick(a.id)}>
							{a.name} <span className="text-muted">· {a.count}</span>
						</button>
					</li>
				))}
			</ul>
		</Modal>
	);
}

/** 逐级浏览文件夹，选“移到这里”。folderId 为 null 表示“不放在任何文件夹”（根目录）。 */
export function FolderPicker({
	onPick,
	onClose,
	title = t.pickers.moveToFolder,
	initial = null,
}: {
	onPick: (folderId: string | null) => void;
	onClose: () => void;
	title?: string;
	initial?: string | null;
}) {
	const [current, setCurrent] = useState<string>(initial ?? "root");
	const { data } = useQuery(folderQuery(current));
	const parent = data?.path.length ? (data.path.length > 1 ? data.path[data.path.length - 2]!.id : "root") : null;
	return (
		<Modal title={title} onClose={onClose}>
			<div className="mb-3 flex items-center gap-2 text-sm">
				{parent && (
					<button className="rounded-md px-2 py-1 hover:bg-surface" onClick={() => setCurrent(parent)} aria-label={t.pickers.up}>
						<IconChevronLeft size={18} />
					</button>
				)}
				<span className="font-medium">{data?.path.map((p) => p.name).join(" / ") || t.pickers.root}</span>
			</div>
			<ul className="mb-4 max-h-72 space-y-1 overflow-y-auto">
				{data?.children.map((f) => (
					<li key={f.id}>
						<button className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-surface" onClick={() => setCurrent(f.id)}>
							<IconFolder size={18} className="shrink-0 text-muted" />
							<span className="truncate">{f.name}</span> <span className="text-muted">· {f.count}</span>
						</button>
					</li>
				))}
				{data?.children.length === 0 && <li className="px-3 py-2 text-sm text-muted">{t.pickers.noSubfolders}</li>}
			</ul>
			<button
				className="btn-primary w-full"
				onClick={() => onPick(current === "root" ? null : current)}
			>
				{t.pickers.moveTo(data?.path.at(-1)?.name ?? null)}
			</button>
		</Modal>
	);
}

/**
 * 主题的范围：逐级浏览文件夹，勾选多个（各自含子文件夹）。一个都不选就是整个资料库。
 * 点名称进入子文件夹，点左边的圆圈选中 / 取消。
 */
export function FolderScopePicker({
	initial,
	onSave,
	onClose,
}: {
	initial: { id: string; name: string }[];
	onSave: (folders: string[]) => void;
	onClose: () => void;
}) {
	const [current, setCurrent] = useState("root");
	const [picked, setPicked] = useState(initial);
	const { data } = useQuery(folderQuery(current));
	const parent = data?.path.length ? (data.path.length > 1 ? data.path[data.path.length - 2]!.id : "root") : null;
	const full = picked.length >= SMART_SET_MAX_FOLDERS;
	const toggle = (f: { id: string; name: string }) =>
		setPicked((p) => (p.some((x) => x.id === f.id) ? p.filter((x) => x.id !== f.id) : full ? p : [...p, { id: f.id, name: f.name }]));
	return (
		<Modal title={t.pickers.topicScope} onClose={onClose}>
			<p className="mb-3 text-sm text-muted">{t.pickers.topicScopeIntro}</p>
			<div className="mb-3 flex flex-wrap gap-1.5">
				{picked.length === 0 && <span className="text-sm text-muted">{t.pickers.topicScopeAll}</span>}
				{picked.map((f) => (
					<button
						key={f.id}
						className="inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-accent-soft px-2.5 text-sm text-accent-ink"
						onClick={() => toggle(f)}
						aria-label={t.pickers.topicScopeRemove(f.name)}
					>
						<span className="truncate">{f.name}</span>
						<IconClose size={14} className="shrink-0" />
					</button>
				))}
			</div>
			<div className="mb-3 flex items-center gap-2 text-sm">
				{parent && (
					<button className="rounded-md px-2 py-1 hover:bg-surface" onClick={() => setCurrent(parent)} aria-label={t.pickers.up}>
						<IconChevronLeft size={18} />
					</button>
				)}
				<span className="font-medium">{data?.path.map((p) => p.name).join(" / ") || t.pickers.root}</span>
			</div>
			<ul className="mb-4 max-h-72 space-y-1 overflow-y-auto">
				{data?.children.map((f) => {
					const on = picked.some((x) => x.id === f.id);
					return (
						<li key={f.id} className="flex items-center gap-1 rounded-md hover:bg-surface">
							<button
								className={`ml-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${on ? "border-accent bg-accent text-accent-fg" : "border-border"} disabled:opacity-40`}
								onClick={() => toggle(f)}
								disabled={!on && full}
								aria-pressed={on}
								aria-label={t.pickers.topicScopeToggle(f.name)}
							>
								{on && <IconCheck size={14} />}
							</button>
							<button
								className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-sm"
								onClick={() => (f.subfolders ? setCurrent(f.id) : toggle(f))}
							>
								<IconFolder size={18} className="shrink-0 text-muted" />
								<span className="truncate">{f.name}</span> <span className="text-muted">· {f.count}</span>
								{f.subfolders > 0 && <IconChevronRight size={16} className="ml-auto shrink-0 text-muted" />}
							</button>
						</li>
					);
				})}
				{data?.children.length === 0 && <li className="px-3 py-2 text-sm text-muted">{t.pickers.noSubfolders}</li>}
			</ul>
			{full && <p className="mb-3 text-sm text-muted">{t.pickers.topicScopeFull(SMART_SET_MAX_FOLDERS)}</p>}
			<button className="btn-primary w-full" onClick={() => onSave(picked.map((f) => f.id))}>
				{picked.length ? t.pickers.topicScopeSave(picked.length) : t.pickers.topicScopeSaveAll}
			</button>
		</Modal>
	);
}

/** 加入主题：作为已有主题的正例或反例，或者新建一个主题（选中的照片作为正例）。 */
export function SmartSetPicker({
	onPick,
	onClose,
}: {
	onPick: (pick: { create: string } | { setId: string; label: 1 | -1 }) => void;
	onClose: () => void;
}) {
	const { data } = useQuery(smartSetsQuery);
	const [name, setName] = useState("");
	const [label, setLabel] = useState<1 | -1>(1);
	const seg = (on: boolean) =>
		`inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full text-sm font-medium transition ${on ? "bg-card text-fg shadow-sm" : "text-muted hover:text-fg"}`;
	return (
		<Modal title={t.pickers.addToTopic} onClose={onClose}>
			<div className="mb-3 flex rounded-full bg-surface p-1" role="radiogroup" aria-label={t.pickers.sampleKind}>
				<button type="button" role="radio" aria-checked={label === 1} className={seg(label === 1)} onClick={() => setLabel(1)}>
					<IconCheck size={16} />
					{t.pickers.asPositive}
				</button>
				<button type="button" role="radio" aria-checked={label === -1} className={seg(label === -1)} onClick={() => setLabel(-1)}>
					<IconClose size={16} />
					{t.pickers.asNegative}
				</button>
			</div>
			<p className="mb-3 text-sm text-muted">{label === 1 ? t.pickers.topicIntro : t.pickers.topicNegativeIntro}</p>
			{/* 新建主题需要正例 */}
			{label === 1 && (
				<form
					className="mb-4 flex gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						if (name.trim()) onPick({ create: name.trim() });
					}}
				>
					<input
						className="flex-1 rounded-md border border-border bg-bg px-3 py-1.5 text-sm"
						placeholder={t.pickers.newTopicName}
						value={name}
						onChange={(e) => setName(e.target.value)}
						maxLength={100}
					/>
					<button className="btn-primary" disabled={!name.trim()}>
						{t.common.create}
					</button>
				</form>
			)}
			<ul className="space-y-1">
				{data?.map((s) => (
					<li key={s.id}>
						<button className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-surface" onClick={() => onPick({ setId: s.id, label })}>
							{s.name} <span className="text-muted">· {t.topics.sampleCount(s.positives, s.negatives)}</span>
						</button>
					</li>
				))}
			</ul>
		</Modal>
	);
}
