import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { t } from "../i18n";
import { IconChevronDown, IconChevronRight } from "../ui/icons";
import { folderTreeQuery } from "./queries";

interface Node {
	id: string;
	name: string;
	hasChildren: boolean;
}

/** 每往下钻一级多缩进这么多（第一级和“文件夹”那一项的图标对齐）。 */
const INDENT = 18;

/**
 * 侧边栏里的文件夹树（“文件夹”那一项下面的部分）：按 parent_id 拼成树，逐级展开，
 * 可以直接跳到任意层级的文件夹。打开某个文件夹时自动展开它的祖先（这样能看到自己在哪、跳到兄弟或上级），
 * 手动展开 / 收起的状态记在内存里，切换页面后保持。
 */
export function FoldersNav() {
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const currentId = pathname.startsWith("/folders/") ? pathname.slice("/folders/".length) : null;
	const { data } = useQuery(folderTreeQuery);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

	// 当前文件夹的祖先（不含它自己）自动展开
	useEffect(() => {
		if (!currentId || currentId === "root" || !data) return;
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
	return (
		<>
			{roots.map((node) => (
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
