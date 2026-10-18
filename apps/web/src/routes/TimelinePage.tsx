import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useRef } from "react";
import { t } from "../i18n";
import { AssetActionsProvider, SelectionBar } from "../library/SelectionBar";
import { SelectionProvider } from "../library/selection";
import { Timeline } from "../timeline/Timeline";
import { timelineNav } from "../viewer/sequence";
import { Viewer } from "../viewer/Viewer";
import { useDocumentTitle } from "../ui/title";

const LIBRARY = { kind: "library" } as const;

export interface TimelineSearch {
	a?: string;
	m?: string;
}

export const validateTimelineSearch = (s: Record<string, unknown>): TimelineSearch => ({
	a: typeof s.a === "string" && /^[0-9A-Z]{26}$/.test(s.a) ? s.a : undefined,
	m: typeof s.m === "string" && /^(\d{4}-\d{2}|unknown)$/.test(s.m) ? s.m : undefined,
});

export function TimelinePage() {
	useDocumentTitle(t.nav.photos);
	const search = useSearch({ from: "/" });
	const navigate = useNavigate({ from: "/" });
	// 从时间线点开的：关闭时用浏览器后退，这样“返回”键和关闭按钮行为一致
	const openedHere = useRef(false);

	const open = useCallback(
		(a: string, m: string) => {
			openedHere.current = true;
			void navigate({ search: { a, m }, resetScroll: false });
		},
		[navigate],
	);
	const move = useCallback(
		(n: { id: string; month?: string }) => void navigate({ search: { a: n.id, m: n.month ?? search.m }, replace: true, resetScroll: false }),
		[navigate, search.m],
	);
	const qc = useQueryClient();
	const close = useCallback(() => {
		if (openedHere.current) {
			openedHere.current = false;
			window.history.back();
		} else {
			void navigate({ search: {}, replace: true, resetScroll: false });
		}
	}, [navigate]);

	return (
		<SelectionProvider>
			<AssetActionsProvider context={LIBRARY}>
				<Timeline onOpen={open} />
				<SelectionBar />
				{search.a && search.m && (
					<Viewer id={search.a} nav={timelineNav(qc, search.a, search.m)} onNavigate={move} onClose={close} />
				)}
			</AssetActionsProvider>
		</SelectionProvider>
	);
}
