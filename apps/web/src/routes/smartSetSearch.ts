import { ASSET_TYPES, type AssetType } from "@nana/shared";

type SampleFilter = "positive" | "negative" | "conflict";
export interface SmartSetSearch {
	a?: string;
	/** 不写是“样本” */
	tab?: "review" | "results";
	/** 样本的筛选 */
	filter?: SampleFilter;
	/** 判断的顺序：不写是最拿不准的在前 */
	order?: "score";
	/** 结果的灵敏度：不写是“标准” */
	level?: "strict" | "loose";
	/** 结果里去掉已经在这个相册里的 */
	album?: string;
	type?: AssetType;
}

const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9A-Z]{26}$/.test(v);

export const validateSmartSetSearch = (s: Record<string, unknown>): SmartSetSearch => ({
	a: isId(s.a) ? s.a : undefined,
	tab: s.tab === "review" || s.tab === "results" ? s.tab : undefined,
	filter: s.filter === "positive" || s.filter === "negative" || s.filter === "conflict" ? s.filter : undefined,
	order: s.order === "score" ? "score" : undefined,
	level: s.level === "strict" || s.level === "loose" ? s.level : undefined,
	album: isId(s.album) ? s.album : undefined,
	type: ASSET_TYPES.includes(s.type as AssetType) ? (s.type as AssetType) : undefined,
});
