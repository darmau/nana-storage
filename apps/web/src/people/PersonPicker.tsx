import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Modal } from "../library/Modal";
import { IconPlus } from "../ui/icons";
import { FaceAvatar, peopleQuery, type Person, personName } from "./model";
import { t } from "../i18n";

/**
 * 选一个人物（合并到…、指定这张脸是谁）。可以按名字筛选；allowNew 时输入的名字没有对应的人物，就提供“新建”。
 * exclude：不出现在列表里的人物（比如自己）。
 */
export function PersonPicker({
	title,
	exclude = [],
	allowNew = false,
	onPick,
	onClose,
}: {
	title: string;
	exclude?: string[];
	allowNew?: boolean;
	onPick: (pick: { person: Person } | { name: string }) => void;
	onClose: () => void;
}) {
	const { data } = useQuery(peopleQuery());
	const [q, setQ] = useState("");
	const query = q.trim();
	const items = useMemo(() => {
		const all = (data?.items ?? []).filter((p) => !exclude.includes(p.id));
		if (!query) return all;
		const lower = query.toLowerCase();
		return all.filter((p) => p.name?.toLowerCase().includes(lower));
	}, [data, exclude, query]);
	const exact = items.find((p) => p.name === query);

	return (
		<Modal title={title} onClose={onClose}>
			<form
				className="mb-3"
				onSubmit={(e) => {
					e.preventDefault();
					if (exact) onPick({ person: exact });
					else if (allowNew && query) onPick({ name: query });
				}}
			>
				<input
					className="field w-full bg-bg"
					placeholder={allowNew ? t.people.pickerPlaceholder : t.people.pickerFilter}
					value={q}
					onChange={(e) => setQ(e.target.value)}
					onKeyDown={(e) => e.stopPropagation() /* 不触发查看器的快捷键 */}
					maxLength={100}
					autoFocus
				/>
			</form>
			<ul className="space-y-0.5">
				{allowNew && query && !exact && (
					<li>
						<button className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-sm hover:bg-surface" onClick={() => onPick({ name: query })}>
							<span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
								<IconPlus size={18} />
							</span>
							{t.people.newPerson(query)}
						</button>
					</li>
				)}
				{items.map((p) => (
					<li key={p.id}>
						<button className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-sm hover:bg-surface" onClick={() => onPick({ person: p })}>
							<FaceAvatar face={p.cover} size={40} />
							<span className={`min-w-0 flex-1 truncate ${p.name ? "" : "text-muted"}`}>{personName(p)}</span>
							<span className="text-xs tabular-nums text-muted">{p.count}</span>
						</button>
					</li>
				))}
				{data && !items.length && !(allowNew && query) && <li className="py-6 text-center text-sm text-muted">{t.people.notFound}</li>}
			</ul>
		</Modal>
	);
}
