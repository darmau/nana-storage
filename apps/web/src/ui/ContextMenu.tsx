import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * 右键菜单。全局只有一个，由 <ContextMenuHost /> 渲染；任何地方调用 openContextMenu(e, items) 打开。
 * openMenuAt(按钮, items) 把同一个菜单挂在按钮下方（页头和多选栏的“更多”），下方放不下时挂在按钮上方。
 * 点击外面、Esc、滚动、窗口变化都会关闭。触屏不弹（长按已经用来多选）。
 */

export type MenuItem =
	| { label: string; icon?: React.ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean }
	| { heading: string }
	| "sep";

interface State {
	x: number;
	y: number;
	items: MenuItem[];
	/** 右边缘对齐 x（挂在按钮下方时） */
	alignRight?: boolean;
	/** 按钮的上边缘：下方放不下时菜单的底边贴在这里，不盖住按钮 */
	above?: number;
}

let state: State | null = null;
const listeners = new Set<() => void>();
const set = (s: State | null) => {
	state = s;
	for (const fn of listeners) fn();
};
const subscribe = (fn: () => void) => {
	listeners.add(fn);
	return () => listeners.delete(fn);
};

export function openContextMenu(e: React.MouseEvent, items: MenuItem[]) {
	e.preventDefault();
	e.stopPropagation();
	set({ x: e.clientX, y: e.clientY, items });
}

/** 在按钮下方打开，右边缘和按钮对齐 */
export function openMenuAt(anchor: HTMLElement, items: MenuItem[]) {
	const r = anchor.getBoundingClientRect();
	set({ x: r.right, y: r.bottom + 4, items, alignRight: true, above: r.top - 4 });
}

export const closeContextMenu = () => set(null);

export function ContextMenuHost() {
	const menu = useSyncExternalStore(subscribe, () => state);
	const ref = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ left: number; top: number; transformOrigin: string } | null>(null);

	// 贴着鼠标，超出窗口就往回挪
	useLayoutEffect(() => {
		if (!menu || !ref.current) return setPos(null);
		const { width, height } = ref.current.getBoundingClientRect();
		const pad = 8;
		const left = Math.max(pad, Math.min(menu.alignRight ? menu.x - width : menu.x, window.innerWidth - width - pad));
		const top = Math.max(pad, menu.y + height + pad > window.innerHeight ? (menu.above ?? menu.y) - height : menu.y);
		// 从鼠标 / 按钮所在的位置展开
		setPos({ left, top, transformOrigin: `${menu.x - left}px ${menu.y - top}px` });
		ref.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
	}, [menu]);

	useEffect(() => {
		if (!menu) return;
		const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && closeContextMenu();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") return closeContextMenu();
			if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
			e.preventDefault();
			const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
			const i = btns.indexOf(document.activeElement as HTMLButtonElement);
			btns[(i + (e.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length]?.focus();
		};
		window.addEventListener("pointerdown", onDown, true);
		window.addEventListener("keydown", onKey, true);
		window.addEventListener("scroll", closeContextMenu, true);
		window.addEventListener("resize", closeContextMenu);
		window.addEventListener("blur", closeContextMenu);
		return () => {
			window.removeEventListener("pointerdown", onDown, true);
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("scroll", closeContextMenu, true);
			window.removeEventListener("resize", closeContextMenu);
			window.removeEventListener("blur", closeContextMenu);
		};
	}, [menu]);

	if (!menu) return null;
	return (
		<div
			ref={ref}
			role="menu"
			className="menu-in fixed z-[70] min-w-48 max-w-72 rounded-xl border border-border bg-card py-1.5 text-sm shadow-xl"
			style={pos ?? { left: menu.x, top: menu.y, visibility: "hidden" }}
			onContextMenu={(e) => e.preventDefault()}
		>
			{menu.items.map((it, i) =>
				it === "sep" ? (
					<div key={i} role="separator" className="my-1.5 border-t border-border" />
				) : "heading" in it ? (
					<div key={i} className="truncate px-3.5 pb-1 pt-0.5 text-xs font-semibold text-muted">
						{it.heading}
					</div>
				) : (
					<button
						key={i}
						type="button"
						role="menuitem"
						disabled={it.disabled}
						className={`flex h-9 w-full items-center gap-3 px-3.5 text-left outline-none hover:bg-surface focus-visible:bg-surface disabled:opacity-45 disabled:hover:bg-transparent ${it.danger ? "text-danger" : ""}`}
						onClick={() => {
							closeContextMenu();
							it.onSelect();
						}}
					>
						<span className="flex w-[18px] shrink-0 justify-center text-muted [&>svg]:h-[18px] [&>svg]:w-[18px]">{it.icon}</span>
						<span className="truncate">{it.label}</span>
					</button>
				),
			)}
		</div>
	);
}
