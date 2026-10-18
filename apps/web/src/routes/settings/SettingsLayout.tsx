import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { t } from "../../i18n";
import { SETTINGS_PAGES } from "./shared";
import { useDocumentTitle } from "../../ui/title";

/**
 * 设置的外壳。宽屏（lg 以上）分页导航紧贴应用侧边栏，内容在剩下的空间里居中；窄屏时概览页本身就是目录，各分页标题旁有返回按钮。
 * 各分页只在打开和点“刷新”时请求数据（后台处理的进度例外，见 ProcessingStatus 的有限次刷新）。
 */
export function SettingsLayout() {
	const pathname = useRouterState({ select: (s) => s.location.pathname.replace(/\/$/, "") });
	const page = SETTINGS_PAGES.find((p) => p.to === pathname);
	useDocumentTitle(page && page.to !== "/settings" ? t.settings.pageTitle(page.label) : t.settings.title);
	return (
		<div className="mx-auto max-w-5xl lg:mx-0 lg:flex lg:max-w-none lg:items-start lg:gap-10">
			<aside className="sticky top-[calc(var(--header-h)+0.75rem)] hidden w-44 shrink-0 lg:block">
				<div className="px-4 pb-3 pt-1 text-2xl font-bold tracking-tight">{t.settings.title}</div>
				<nav aria-label={t.settings.pagesNav} className="flex flex-col gap-0.5">
					{SETTINGS_PAGES.map(({ to, label, icon: Icon }) => (
						<Link
							key={to}
							to={to}
							activeOptions={{ exact: true, includeSearch: false }}
							className="flex min-h-10 items-center gap-3 rounded-full px-4 text-sm font-medium text-fg/80 transition hover:bg-surface hover:text-fg"
							activeProps={{ className: "!bg-accent-soft !text-accent-ink font-semibold" }}
						>
							<Icon size={18} />
							{label}
						</Link>
					))}
				</nav>
			</aside>
			<div className="min-w-0 flex-1">
				<div className="mx-auto max-w-3xl">
					<Outlet />
				</div>
			</div>
		</div>
	);
}
