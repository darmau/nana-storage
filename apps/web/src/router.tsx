import { Link, Outlet, createRootRoute, createRoute, createRouter, redirect, useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useEffect } from "react";
import { t } from "./i18n";
import { ContextMenuHost, openMenuAt } from "./ui/ContextMenu";
import { pageTransition } from "./ui/motion";
import { PullToRefresh } from "./ui/PullToRefresh";
import { hideSplash } from "./ui/splash";
import { ConnectionBanner } from "./routes/ConnectionBanner";
import { GuardBanner } from "./routes/GuardBanner";
import { BurstPage } from "./routes/BurstPage";
import { LibraryHome } from "./routes/LibraryHome";
import { exploreSearch, SearchBox, SearchPage } from "./routes/SearchPage";
import { AlbumPage, AlbumsPage, ArchivePage, FavoritesPage, FoldersPage, TrashPage } from "./routes/LibraryPages";
import { PeoplePage, PersonPage } from "./routes/PeoplePages";
import { CompressPage, OrganizePage } from "./routes/OrganizePages";
import { DuplicatesPage } from "./routes/DuplicatesPage";
import { SmartSetPage, SmartSetsPage, validateSmartSetSearch } from "./routes/SmartSetPages";
import { TimelinePage, validateTimelineSearch } from "./routes/TimelinePage";
import { StatsPage } from "./routes/StatsPage";
import { StorageMeter } from "./library/StorageMeter";
import { folderSearch, listSearch } from "./library/TypeFilter";
import { GuardPage } from "./routes/settings/GuardPage";
import { ProcessingPage } from "./routes/settings/ProcessingPage";
import { SettingsLayout } from "./routes/settings/SettingsLayout";
import { SettingsOverview } from "./routes/settings/SettingsOverview";
import { DropUpload, useUploadTarget } from "./upload/DropUpload";
import { UploadPanel } from "./upload/UploadPanel";
import { UploadPicker, uploadMenuItems } from "./upload/picker";
import { ProgressRing, UploadWatcher, useUploadProgress } from "./upload/UploadStatus";
import {
	IconAlbum,
	IconArchive,
	IconChart,
	IconChevronRight,
	IconCompass,
	IconFolder,
	IconHeart,
	IconLibrary,
	IconLogo,
	IconMap,
	IconOrganize,
	IconPeople,
	IconPhotos,
	IconSettings,
	IconSimilar,
	IconTrash,
	IconUpload,
} from "./ui/icons";

/**
 * 资料库下的页面：移动端底部的“资料库”标签在这些页面上都算选中（相册、文件夹有自己的标签）。
 * 整理（重复照片、相似照片、原图压缩）在移动端没有自己的标签，入口平铺在资料库首页，所以也算在这里。
 */
const LIBRARY_PATHS = ["/library", "/favorites", "/archive", "/trash", "/organize", "/duplicates", "/compress"];
/** 探索下的页面：移动端底部的“探索”标签在这些页面上也算选中（地图、统计数据在移动端从探索页进入） */
const EXPLORE_PATHS = ["/search", "/people", "/smart-sets", "/map", "/stats"];
const under = (pathname: string, p: string) => pathname === p || pathname.startsWith(`${p}/`);

/**
 * 外壳：
 *  - 桌面（md 以上）：顶栏（搜索框、上传、设置）+ 左侧固定侧边栏，内容随窗口滚动（时间线的虚拟化依赖窗口滚动）。
 *  - 移动端：精简顶栏 + 底部五个标签（照片 / 相册 / 探索 / 文件夹 / 资料库）。
 * 尺寸都来自 styles.css 里的 --header-h / --sidebar-w / --tabbar-h，地图页、拖动条、操作栏按这些变量避让。
 */
function Layout() {
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const inLibrary = LIBRARY_PATHS.some((p) => under(pathname, p));
	const inExplore = EXPLORE_PATHS.some((p) => under(pathname, p));
	// “上传”弹出两项菜单，直接打开系统的选择器：在某个文件夹里传到这个文件夹，其他页面传到根目录
	const uploadTarget = useUploadTarget();
	const openUploadMenu = (e: React.MouseEvent<HTMLElement>) =>
		openMenuAt(e.currentTarget, uploadMenuItems(uploadTarget, uploadTarget ? "folder" : "none"));
	// 上传在后台进行，切换页面不受影响；顶栏按钮显示进度
	const uploadPct = useUploadProgress();
	// 外壳已经画出来了：撤掉 index.html 的启动画面，之后由各页的骨架屏接手
	useEffect(hideSplash, []);

	return (
		<div className="min-h-dvh">
			<header className="sticky top-0 z-30 flex [view-transition-name:app-header] h-[var(--header-h)] select-none items-center gap-3 border-b border-border bg-bg/90 pl-[max(0.75rem,var(--safe-left))] pr-[max(0.75rem,var(--safe-right))] pt-[var(--safe-top)] backdrop-blur md:pl-[max(1rem,var(--safe-left))] md:pr-[max(1rem,var(--safe-right))]">
				<Link to="/" className="flex shrink-0 items-center gap-2.5 rounded-lg md:w-[calc(var(--sidebar-w)-var(--safe-left)-1rem)] md:pl-2" aria-label={t.nav.home(t.app.name)}>
					<IconLogo />
					<span className="text-lg font-bold tracking-wide">{t.app.name}</span>
				</Link>
				{/* 唯一的搜索框（桌面）：输入就跳到探索页显示结果；手机顶栏放不下，搜索框在探索页里 */}
				<SearchBox className="hidden h-11 max-w-2xl flex-1 md:flex" />
				<div className="ml-auto flex items-center gap-1">
					<button type="button" className="btn hidden sm:inline-flex" aria-haspopup="menu" onClick={openUploadMenu}>
						<IconUpload size={18} />
						{t.nav.upload}
						{uploadPct !== null && <span className="tabular-nums text-accent-ink">{uploadPct}%</span>}
					</button>
					<button
						type="button"
						className="icon-btn relative sm:hidden"
						aria-haspopup="menu"
						aria-label={uploadPct !== null ? t.nav.uploadingPct(uploadPct) : t.nav.upload}
						onClick={openUploadMenu}
					>
						<IconUpload />
						{uploadPct !== null && <ProgressRing pct={uploadPct} />}
					</button>
					<Link to="/settings" className="icon-btn" aria-label={t.nav.settings} activeProps={{ className: "bg-surface" }}>
						<IconSettings />
					</Link>
				</div>
			</header>

			<ConnectionBanner />
			<GuardBanner />
			<UploadWatcher />
			<UploadPanel />
			<DropUpload />
			<UploadPicker />
			<ContextMenuHost />
			<PullToRefresh />

			<nav
				aria-label={t.nav.main}
				className="fixed bottom-0 left-0 top-[var(--header-h)] z-20 hidden [view-transition-name:app-sidebar] w-[var(--sidebar-w)] select-none flex-col gap-0.5 overflow-y-auto overscroll-contain pb-[max(1.5rem,var(--safe-bottom))] pl-[calc(0.5rem+var(--safe-left))] pr-2 pt-3 md:flex"
			>
				<SideLink to="/" icon={<IconPhotos />} exact>
					{t.nav.photos}
				</SideLink>
				<SideLink to="/albums" icon={<IconAlbum />}>
					{t.albums.title}
				</SideLink>
				<Link
					to="/folders/$folderId"
					params={{ folderId: "root" }}
					className={`${sideClass} ${pathname.startsWith("/folders/") ? sideActive.className : ""}`}
				>
					<IconFolder />
					{t.folders.title}
				</Link>
				<SideLink to="/favorites" icon={<IconHeart />}>
					{t.favorites.title}
				</SideLink>
				<SideLink to="/archive" icon={<IconArchive />}>
					{t.archive.title}
				</SideLink>
				{/* 整理：重复照片、相似照片、原图压缩都在这一页里，进入其中一个时这一项也算选中 */}
				<SideLink to="/organize" icon={<IconOrganize />} forceActive={["/organize", "/duplicates", "/compress"].some((p) => under(pathname, p))}>
					{t.organize.title}
				</SideLink>
				{/* 小标题本身就是探索页的入口（搜索结果也在那里） */}
				<Link
					to="/search"
					className="mt-4 flex items-center gap-1 self-start rounded-full px-4 py-1 text-xs font-semibold tracking-wider text-muted transition hover:bg-surface hover:text-fg"
					activeProps={{ className: "!text-accent-ink" }}
					activeOptions={{ includeSearch: false }}
				>
					{t.nav.explore}
					<IconChevronRight size={14} />
				</Link>
				<SideLink to="/people" icon={<IconPeople />}>
					{t.people.title}
				</SideLink>
				<SideLink to="/smart-sets" icon={<IconSimilar />}>
					{t.topics.title}
				</SideLink>
				<SideLink to="/map" icon={<IconMap />}>
					{t.nav.map}
				</SideLink>
				<SideLink to="/stats" icon={<IconChart />}>
					{t.stats.title}
				</SideLink>
				<div className="mx-4 my-3 border-t border-border" />
				<SideLink to="/trash" icon={<IconTrash />}>
					{t.trash.title}
				</SideLink>
				<StorageMeter className="mt-auto" />
			</nav>

			<main className="px-2 pb-[calc(var(--tabbar-h)+1.5rem)] pt-3 sm:px-4 md:pb-[max(2.5rem,var(--safe-bottom))] md:pl-[calc(var(--sidebar-w)+0.5rem)] md:pr-[max(1.5rem,var(--safe-right))]">
				<Outlet />
			</main>

			<nav
				aria-label={t.nav.tabbar}
				className="fixed inset-x-0 bottom-0 z-30 flex h-[var(--tabbar-h)] [view-transition-name:app-tabbar] select-none items-stretch border-t border-border bg-card/95 pb-[var(--safe-bottom)] pl-[max(0.25rem,var(--safe-left))] pr-[max(0.25rem,var(--safe-right))] backdrop-blur md:hidden"
			>
				<Tab to="/" icon={<IconPhotos />} exact>
					{t.nav.photos}
				</Tab>
				<Tab to="/albums" icon={<IconAlbum />}>
					{t.albums.title}
				</Tab>
				<Tab to="/search" icon={<IconCompass />} forceActive={inExplore}>
					{t.nav.explore}
				</Tab>
				<Tab to="/folders/$folderId" params={{ folderId: "root" }} icon={<IconFolder />} forceActive={pathname.startsWith("/folders/")}>
					{t.folders.title}
				</Tab>
				<Tab to="/library" icon={<IconLibrary />} forceActive={inLibrary}>
					{t.nav.library}
				</Tab>
			</nav>
		</div>
	);
}

const sideClass =
	"flex min-h-11 items-center gap-3.5 rounded-full px-4 text-sm font-medium text-fg/80 transition hover:bg-surface hover:text-fg";
const sideActive = { className: "!bg-accent-soft !text-accent-ink font-semibold" };

function SideLink({
	to,
	icon,
	exact,
	forceActive,
	children,
}: {
	to: "/" | "/map" | "/people" | "/smart-sets" | "/stats" | "/albums" | "/favorites" | "/archive" | "/organize" | "/trash";
	icon: React.ReactNode;
	exact?: boolean;
	forceActive?: boolean;
	children: React.ReactNode;
}) {
	return (
		<Link
			to={to}
			className={`${sideClass} ${forceActive ? sideActive.className : ""}`}
			activeProps={sideActive}
			activeOptions={{ exact: !!exact, includeSearch: false }}
		>
			{icon}
			{children}
		</Link>
	);
}

function Tab({
	to,
	params,
	icon,
	exact,
	forceActive,
	children,
}: {
	to: "/" | "/albums" | "/search" | "/folders/$folderId" | "/library";
	params?: { folderId: string };
	icon: React.ReactNode;
	exact?: boolean;
	forceActive?: boolean;
	children: React.ReactNode;
}) {
	return (
		<Link
			to={to}
			params={params as never}
			activeOptions={{ exact: !!exact, includeSearch: false }}
			className="flex flex-1 flex-col items-center justify-center gap-1 text-fg/75">
			{({ isActive }: { isActive: boolean }) => {
				const on = isActive || forceActive;
				return (
					<>
						<span className={`flex h-8 w-full max-w-16 items-center justify-center rounded-full transition ${on ? "tab-pill-in bg-accent-soft text-accent-ink" : ""}`}>{icon}</span>
						<span className={`text-xs ${on ? "font-bold text-fg" : "font-medium"}`}>{children}</span>
					</>
				);
			}}
		</Link>
	);
}

// 地图库约 1 MB，只在打开地图页时加载
const MapPage = lazy(() => import("./routes/MapPage").then((m) => ({ default: m.MapPage })));
const LazyMap = () => (
	<Suspense fallback={<p className="text-muted">{t.nav.loadingMap}</p>}>
		<MapPage />
	</Suspense>
);

const viewerSearch = (s: Record<string, unknown>): { a?: string } => ({
	a: typeof s.a === "string" && /^[0-9A-Z]{26}$/.test(s.a) ? s.a : undefined,
});

const rootRoute = createRootRoute({ component: Layout });

// 设置：外壳 + 分页（宽屏时左侧有分页导航）
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsLayout });
const settingsTree = settingsRoute.addChildren([
	createRoute({ getParentRoute: () => settingsRoute, path: "/", component: SettingsOverview }),
	createRoute({ getParentRoute: () => settingsRoute, path: "/processing", component: ProcessingPage }),
	createRoute({ getParentRoute: () => settingsRoute, path: "/guard", component: GuardPage }),
	// 使用统计搬到了 /stats，旧书签跳过去
	createRoute({ getParentRoute: () => settingsRoute, path: "/usage", beforeLoad: () => { throw redirect({ to: "/stats", replace: true }); } }),
]);
const routeTree = rootRoute.addChildren([
	createRoute({ getParentRoute: () => rootRoute, path: "/", component: TimelinePage, validateSearch: validateTimelineSearch }),
	createRoute({ getParentRoute: () => rootRoute, path: "/library", component: LibraryHome }),
	createRoute({ getParentRoute: () => rootRoute, path: "/folders/$folderId", component: FoldersPage, validateSearch: folderSearch }),
	createRoute({ getParentRoute: () => rootRoute, path: "/albums", component: AlbumsPage }),
	createRoute({ getParentRoute: () => rootRoute, path: "/albums/$albumId", component: AlbumPage, validateSearch: listSearch }),
	createRoute({ getParentRoute: () => rootRoute, path: "/map", component: LazyMap, validateSearch: viewerSearch }),
	createRoute({ getParentRoute: () => rootRoute, path: "/bursts/$assetId", component: BurstPage, validateSearch: viewerSearch }),
	createRoute({ getParentRoute: () => rootRoute, path: "/favorites", component: FavoritesPage, validateSearch: viewerSearch }),
	createRoute({ getParentRoute: () => rootRoute, path: "/people", component: PeoplePage }),
	createRoute({ getParentRoute: () => rootRoute, path: "/people/$personId", component: PersonPage, validateSearch: listSearch }),
	createRoute({ getParentRoute: () => rootRoute, path: "/smart-sets", component: SmartSetsPage }),
	createRoute({ getParentRoute: () => rootRoute, path: "/smart-sets/$setId", component: SmartSetPage, validateSearch: validateSmartSetSearch }),
	createRoute({ getParentRoute: () => rootRoute, path: "/duplicates", component: DuplicatesPage, validateSearch: viewerSearch }),
	createRoute({ getParentRoute: () => rootRoute, path: "/organize", component: OrganizePage }),
	createRoute({ getParentRoute: () => rootRoute, path: "/compress", component: CompressPage, validateSearch: viewerSearch }),
	createRoute({ getParentRoute: () => rootRoute, path: "/archive", component: ArchivePage, validateSearch: listSearch }),
	createRoute({ getParentRoute: () => rootRoute, path: "/trash", component: TrashPage, validateSearch: viewerSearch }),
	createRoute({ getParentRoute: () => rootRoute, path: "/search", component: SearchPage, validateSearch: exploreSearch }),
	createRoute({ getParentRoute: () => rootRoute, path: "/stats", component: StatsPage, validateSearch: viewerSearch }),
	settingsTree,
]);

export const router = createRouter({ routeTree, defaultViewTransition: pageTransition });

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
