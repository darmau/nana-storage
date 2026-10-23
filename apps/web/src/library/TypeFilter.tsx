import { ASSET_TYPES, type AssetType } from "@nana/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";
import { t } from "../i18n";

/** 类型的显示名称：顺序和 ASSET_TYPES 一致（媒体类型在前，照片类型在后），搜索页也用它 */
export const ASSET_TYPE_LABELS: Record<AssetType, string> = t.library.types;

/** 文件夹 / 相册页的地址参数：查看器打开的照片（?a=）、类型筛选（?type=）和“显示归档照片”（?archived=1） */
export const listSearch = (s: Record<string, unknown>): { a?: string; type?: AssetType; archived?: 1 } => ({
	a: typeof s.a === "string" && /^[0-9A-Z]{26}$/.test(s.a) ? s.a : undefined,
	type: ASSET_TYPES.includes(s.type as AssetType) ? (s.type as AssetType) : undefined,
	archived: s.archived === 1 || s.archived === "1" ? 1 : undefined,
});

/** 文件夹页另外可以按人物筛选（?person=，只看有这个人物的脸的照片） */
export const folderSearch = (s: Record<string, unknown>): ReturnType<typeof listSearch> & { person?: string } => ({
	...listSearch(s),
	person: typeof s.person === "string" && /^[0-9A-Z]{26}$/.test(s.person) ? s.person : undefined,
});

/** 文件夹页当前的人物筛选，切换方式和类型筛选一样（替换历史记录，关掉查看器） */
export function usePersonFilter(): [string | undefined, (person: string | undefined) => void] {
	const { person } = useSearch({ strict: false }) as { person?: string };
	const navigate = useNavigate();
	const set = useCallback(
		(next: string | undefined) =>
			void navigate({ to: ".", search: (prev: Record<string, unknown>) => ({ ...prev, person: next, a: undefined }), replace: true }),
		[navigate],
	);
	return [person, set];
}

/** 当前的类型筛选（记在地址里，打开查看器、前进后退、刷新都保留）。切换时替换历史记录，不多出一条。 */
export function useTypeFilter(): [AssetType | undefined, (type: AssetType | undefined) => void] {
	const { type } = useSearch({ strict: false }) as { type?: AssetType };
	const navigate = useNavigate();
	const set = useCallback(
		(next: AssetType | undefined) =>
			void navigate({ to: ".", search: (prev: Record<string, unknown>) => ({ ...prev, type: next, a: undefined }), replace: true }),
		[navigate],
	);
	return [type, set];
}

/** 文件夹 / 相册页是否显示归档的照片（记在地址里，和类型筛选一样替换历史记录、关掉查看器） */
export function useShowArchived(): [boolean, (show: boolean) => void] {
	const { archived } = useSearch({ strict: false }) as { archived?: 1 };
	const navigate = useNavigate();
	const set = useCallback(
		(show: boolean) =>
			void navigate({ to: ".", search: (prev: Record<string, unknown>) => ({ ...prev, archived: show ? 1 : undefined, a: undefined }), replace: true }),
		[navigate],
	);
	return [archived === 1, set];
}

/** 列表接口的地址加上类型筛选 */
export const withType = (path: string, type: AssetType | undefined) => (type ? `${path}?type=${type}` : path);

/** 列表接口的地址加上查询参数（类型筛选、显示归档、列表视图、文件夹的排序），值为空的不加 */
export function listPath(
	path: string,
	params: { type?: AssetType; archived?: boolean; view?: "list"; sort?: { key: string; asc: boolean } },
) {
	const q = new URLSearchParams();
	if (params.type) q.set("type", params.type);
	if (params.archived) q.set("archived", "1");
	if (params.view) q.set("view", params.view);
	// 默认的“拍摄时间从新到旧”不带参数，地址（和缓存）和以前一样
	if (params.sort && (params.sort.key !== "taken" || params.sort.asc)) {
		q.set("sort", params.sort.key);
		if (params.sort.asc) q.set("order", "asc");
	}
	const s = q.toString();
	return s ? `${path}?${s}` : path;
}

/** 文件夹 / 相册页的“显示归档照片”勾选框，放在类型筛选条下面 */
export function ShowArchivedToggle({ value, onChange }: { value: boolean; onChange: (show: boolean) => void }) {
	return (
		<label className="inline-flex shrink-0 cursor-pointer select-none items-center gap-2 whitespace-nowrap text-sm text-muted">
			<input type="checkbox" className="h-4 w-4 accent-accent" checked={value} onChange={(e) => onChange(e.target.checked)} />
			{t.archive.showArchived}
		</label>
	);
}

const chip = "h-8 shrink-0 rounded-full border px-3 text-sm font-medium transition";

/** 横向的类型筛选条，单选；再点一次已选中的类型取消筛选。窄屏放不下时可以横向滑动。 */
export function TypeFilter({ value, onChange }: { value: AssetType | undefined; onChange: (type: AssetType | undefined) => void }) {
	const item = (type: AssetType | undefined, label: string) => {
		const active = value === type;
		return (
			<button
				key={type ?? "all"}
				type="button"
				aria-pressed={active}
				className={`${chip} ${active ? "border-transparent bg-fg text-bg" : "border-border bg-card text-fg hover:bg-surface"}`}
				onClick={() => onChange(active ? undefined : type)}
			>
				{label}
			</button>
		);
	};
	return (
		<div role="group" aria-label={t.library.typeFilter} className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
			{item(undefined, t.library.allTypes)}
			{ASSET_TYPES.map((type) => item(type, ASSET_TYPE_LABELS[type]))}
		</div>
	);
}
