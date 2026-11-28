import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { IconClose, IconSearch } from "../ui/icons";

/** 探索页的地址参数：搜索词（?q=，顶栏的搜索框也写这里）和查看器打开的照片（?a=） */
export const exploreSearch = (s: Record<string, unknown>): { a?: string; q?: string } => ({
	a: typeof s.a === "string" && /^[0-9A-Z]{26}$/.test(s.a) ? s.a : undefined,
	q: typeof s.q === "string" && s.q ? s.q.slice(0, 200) : undefined,
});

/** 搜索词：顶栏（桌面）和探索页（手机）的输入框共用，都写进 /search 的 ?q=。 */
export function useSearchInput(): [string, (value: string) => void] {
	const onExplore = useRouterState({ select: (s) => s.location.pathname === "/search" });
	const { q } = useSearch({ strict: false }) as { q?: string };
	const navigate = useNavigate();
	const urlQ = onExplore ? (q ?? "") : "";
	const [value, setValue] = useState(urlQ);
	const typed = useRef(urlQ);
	useEffect(() => {
		if (urlQ === typed.current) return;
		typed.current = urlQ;
		setValue(urlQ);
	}, [urlQ]);
	const change = useCallback(
		(v: string) => {
			setValue(v);
			typed.current = v;
			void navigate({
				to: "/search",
				search: (prev: Record<string, unknown>) => ({ ...(onExplore ? prev : {}), q: v || undefined, a: undefined }),
				replace: onExplore,
			});
		},
		[navigate, onExplore],
	);
	return [value, change];
}

/** 搜索框本体：顶栏和探索页（只在手机上显示）共用。 */
export function SearchBox({ className = "", autoFocus }: { className?: string; autoFocus?: boolean }) {
	const [value, setValue] = useSearchInput();
	return (
		<label
			className={`flex items-center gap-3 rounded-full border border-transparent bg-surface px-4 transition focus-within:border-border focus-within:bg-card focus-within:shadow-[0_2px_12px_rgb(0_0_0/0.08)] ${className}`}
		>
			<IconSearch className="shrink-0 text-fg" />
			<input
				type="search"
				autoFocus={autoFocus}
				className="h-full min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-muted focus-visible:outline-none md:text-sm [&::-webkit-search-cancel-button]:hidden"
				placeholder={t.nav.searchHint}
				aria-label={t.search.placeholder}
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => e.key === "Escape" && value && setValue("")}
				maxLength={200}
			/>
			{value && (
				<button type="button" className="-mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2" aria-label={t.search.clear} onClick={() => setValue("")}>
					<IconClose size={18} />
				</button>
			)}
		</label>
	);
}
