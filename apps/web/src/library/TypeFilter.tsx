import { ASSET_TYPES, type AssetType } from "@nana/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";
import { t } from "../i18n";

/** 类型的显示名称：顺序和 ASSET_TYPES 一致（媒体类型在前，照片类型在后），搜索页也用它 */
export const ASSET_TYPE_LABELS: Record<AssetType, string> = t.library.types;

/** 文件夹 / 相册页的地址参数：查看器打开的照片（?a=）和类型筛选（?type=） */
export const listSearch = (s: Record<string, unknown>): { a?: string; type?: AssetType } => ({
	a: typeof s.a === "string" && /^[0-9A-Z]{26}$/.test(s.a) ? s.a : undefined,
	type: ASSET_TYPES.includes(s.type as AssetType) ? (s.type as AssetType) : undefined,
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

/** 列表接口的地址加上类型筛选 */
export const withType = (path: string, type: AssetType | undefined) => (type ? `${path}?type=${type}` : path);

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
