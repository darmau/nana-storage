import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

/** 与批量接口的上限一致 */
export const MAX_SELECTION = 1000;

/** 一张照片在当前页面里的位置。scope 是它所在的分组（时间线里是月份），帮排序函数少找一些。 */
export interface Anchor {
	id: string;
	scope?: string;
}

/**
 * 按页面上的显示顺序，返回 from 到 to（含两端）之间的 id；找不到 from 时返回 null。
 * 最多返回 limit 个，排序函数可以据此少加载一些数据。
 */
export type RangeFn = (from: Anchor, to: Anchor, limit: number) => string[] | null | Promise<string[] | null>;

/** 当前页面的多选状态。有任何选中项时，点击格子就是“选择”而不是“打开”。 */
interface Selection {
	selected: Set<string>;
	active: boolean;
	/** group：这个格子代表的一组照片（连拍），和 id 一起选上或取消。 */
	toggle: (id: string, scope?: string, group?: string[]) => void;
	/** Shift 点击：把上一次点的那张到这一张之间的都选上；没有上一次就当普通点击。 */
	extend: (id: string, scope?: string, group?: string[]) => void;
	/** 一次选上或取消一组（比如某一天的全部照片）。 */
	setMany: (ids: string[], on: boolean) => void;
	clear: () => void;
	/** 网格把自己的排序函数登记在这里，供 extend 使用。 */
	setRange: (fn: RangeFn | null) => void;
}

const Ctx = createContext<Selection | null>(null);

function addAll(prev: Set<string>, ids: string[]) {
	const next = new Set(prev);
	for (const id of ids) {
		if (next.size >= MAX_SELECTION) break;
		next.add(id);
	}
	return next;
}

export function SelectionProvider({ children }: { children: React.ReactNode }) {
	const [selected, setSelected] = useState<Set<string>>(() => new Set());
	const anchor = useRef<Anchor | null>(null);
	const range = useRef<RangeFn | null>(null);

	const toggle = useCallback((id: string, scope?: string, group?: string[]) => {
		anchor.current = { id, scope };
		setSelected((prev) => {
			if (!prev.has(id)) return addAll(prev, group ?? [id]);
			const next = new Set(prev);
			for (const g of group ?? [id]) next.delete(g);
			return next;
		});
	}, []);

	const extend = useCallback(
		(id: string, scope?: string, group?: string[]) => {
			const from = anchor.current;
			const fn = range.current;
			if (!from || !fn || from.id === id) return toggle(id, scope, group);
			const to = { id, scope };
			anchor.current = to;
			void Promise.resolve(fn(from, to, MAX_SELECTION))
				.catch(() => null)
				.then((ids) => setSelected((prev) => addAll(prev, ids ?? group ?? [id])));
		},
		[toggle],
	);

	const setMany = useCallback((ids: string[], on: boolean) => {
		setSelected((prev) => {
			if (on) return addAll(prev, ids);
			const next = new Set(prev);
			for (const id of ids) next.delete(id);
			return next;
		});
	}, []);

	const clear = useCallback(() => {
		anchor.current = null;
		setSelected(new Set());
	}, []);
	const setRange = useCallback((fn: RangeFn | null) => {
		range.current = fn;
	}, []);

	const value = useMemo(
		() => ({ selected, active: selected.size > 0, toggle, extend, setMany, clear, setRange }),
		[selected, toggle, extend, setMany, clear, setRange],
	);
	return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSelection(): Selection {
	const s = useContext(Ctx);
	if (!s) throw new Error("useSelection outside SelectionProvider");
	return s;
}

/** 在一个有序数组里取 from 到 to 之间的 id（两个方向都可以）。 */
export function sliceBetween(ids: string[], from: string, to: string, limit: number): string[] | null {
	const a = ids.indexOf(from);
	const b = ids.indexOf(to);
	if (a < 0 || b < 0) return null;
	const out = a <= b ? ids.slice(a, b + 1) : ids.slice(b, a + 1).reverse();
	return out.slice(0, limit);
}
