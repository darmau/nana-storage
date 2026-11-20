import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { IconChevronDown, IconChevronRight, IconFolder } from "../ui/icons";
import { folderTreeQuery } from "./queries";

interface Node {
	id: string;
	name: string;
	hasChildren: boolean;
}

/** 每往下钻一级多缩进这么多（第一级和“文件夹”那一项的图标对齐）。 */
const INDENT = 18;

/**
 * 侧边栏里的“文件夹”项：默认收起（只有一行标题），进入文件夹时展开成树，逐级展开可以直接跳到任意层级。
 *  - 打开文件夹首页（/folders/root）只展开第一级；进入某个子文件夹时展开它的祖先链（看到自己在哪、跳到兄弟或上级）。
 *  - 在照片 / 相册等页面（不在 /folders/* 里）自动收起；也可以点标题右边的箭头手动展开 / 收起。
 *  - 手动展开 / 收起的状态记在内存里，切换页面后保持。
 */
export function FoldersNav() {
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const currentId = pathname.startsWith("/folders/") ? pathname.slice("/folders/".length) : null;
	const { data } = useQuery(folderTreeQuery);
	const [open, setOpen] = useState(() => currentId !== null);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

	// 进入 /folders/* 时展开，离开时收起；在文件夹之间跳转、或手动切换过之后保持原样。
	const prevInFolders = useRef(currentId !== null);
	useEffect(() => {
		const inFolders = currentId !== null;
		if (inFolders === prevInFolders.current) return;
		prevInFolders.current = inFolders;
		setOpen(inFolders);
	}, [currentId]);

	// 文件夹首页只展开第一级；进入子文件夹时展开它的祖先链
	useEffect(() => {
		if (currentId === "root") {
			setExpanded(new Set());
			return;
		}
		if (!currentId || !data) return;
		const parentOf = new Map(data.items.map((f) => [f.id, f.parent_id]));
		const chain: string[] = [];
		for (let cur = parentOf.get(currentId) ?? null; cur; cur = parentOf.get(cur) ?? null) chain.push(cur);
		if (!chain.length) return;
		setExpanded((prev) => {
			if (chain.every((id) => prev.has(id))) return prev;
			const next = new Set(prev);
			for (const id of chain) next.add(id);
			return next;
		});
	}, [currentId, data]);

	const byParent = useMemo(() => {
		const m = new Map<string | null, Node[]>();
		const kids = new Map<string | null, number>();
		for (const f of data?.items ?? []) kids.set(f.parent_id, (kids.get(f.parent_id) ?? 0) + 1);
		for (const f of data?.items ?? []) {
			const list = m.get(f.parent_id) ?? [];
			list.push({ id: f.id, name: f.name, hasChildren: (kids.get(f.id) ?? 0) > 0 });
			m.set(f.parent_id, list);
		}
		for (const list of m.values()) list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
		return m;
	}, [data]);

	const toggle = (id: string) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	const roots = byParent.get(null) ?? [];
	const headerActive = currentId === "root";
	const toggleLabel = open ? t.folders.collapse : t.folders.expand;
	return (
		<>
			<div className={`flex items-center rounded-full pr-1 transition ${headerActive ? "bg-accent-soft text-accent-ink" : "text-fg/80 hover:bg-surface hover:text-fg"}`}>
				<Link
					to="/folders/$folderId"
					params={{ folderId: "root" }}
					className={`flex min-h-11 min-w-0 flex-1 items-center gap-3.5 pl-4 text-sm ${headerActive ? "font-semibold" : "font-medium"}`}
				>
					<IconFolder />
					{t.folders.title}
				</Link>
				<button
					type="button"
					className="flex h-11 w-9 shrink-0 items-center justify-center rounded-full text-muted transition hover:text-fg"
					aria-expanded={open}
					aria-label={toggleLabel}
					title={toggleLabel}
					onClick={() => setOpen((v) => !v)}
				>
					{open ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
				</button>
			</div>
			{open &&
				roots.map((node) => (
					<Row key={node.id} node={node} depth={1} byParent={byParent} expanded={expanded} currentId={currentId} onToggle={toggle} />
				))}
		</>
	);
}

function Row({
	node,
	depth,
	byParent,
	expanded,
	currentId,
	onToggle,
}: {
	node: Node;
	depth: number;
	byParent: Map<string | null, Node[]>;
	expanded: ReadonlySet<string>;
	currentId: string | null;
	onToggle: (id: string) => void;
}) {
	const open = expanded.has(node.id);
	const active = currentId === node.id;
	const children = byParent.get(node.id) ?? [];
	const label = open ? t.folders.collapse : t.folders.expand;
	return (
		<>
			<div
				className={`flex items-center rounded-lg pr-1 transition ${active ? "bg-accent-soft text-accent-ink" : "text-fg/80 hover:bg-surface hover:text-fg"}`}
				style={{ paddingLeft: 16 + (depth - 1) * INDENT }}
			>
				{node.hasChildren ? (
					<button
						type="button"
						className="flex h-9 w-6 shrink-0 items-center justify-center rounded text-muted transition hover:text-fg"
						aria-label={label}
						title={label}
						aria-expanded={open}
						onClick={() => onToggle(node.id)}
					>
						{open ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
					</button>
				) : (
					<span className="w-6 shrink-0" />
				)}
				<Link to="/folders/$folderId" params={{ folderId: node.id }} className="flex h-9 min-w-0 flex-1 items-center rounded-lg pr-2 text-sm font-medium">
					<span className="truncate">{node.name}</span>
				</Link>
			</div>
			{open && children.map((c) => <Row key={c.id} node={c} depth={depth + 1} byParent={byParent} expanded={expanded} currentId={currentId} onToggle={onToggle} />)}
		</>
	);
}
