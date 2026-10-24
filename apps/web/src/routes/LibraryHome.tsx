import { Link } from "@tanstack/react-router";
import { t } from "../i18n";
import { StorageMeter } from "../library/StorageMeter";
import { IconArchive, IconHeart, IconTrash } from "../ui/icons";
import { useDocumentTitle } from "../ui/title";
import { ORGANIZE_ITEMS, OrganizeLink } from "./OrganizePages";

/**
 * 资料库首页（移动端底部“资料库”标签的落点；桌面端这些入口在侧边栏里）。
 * 只放别处没有的入口（收藏、归档、回收站）：相册、文件夹有自己的标签，人物在探索页里，不在这里重复。
 * 整理（重复照片、相似照片、原图压缩）在移动端没有自己的标签，三个入口直接平铺在这里（桌面端在侧边栏的“整理”页）。
 */
export function LibraryHome() {
	useDocumentTitle(t.nav.library);
	const quick =
		"flex min-h-20 flex-col items-start justify-center gap-2 rounded-2xl border border-border bg-card px-4 text-sm font-semibold hover:bg-surface sm:min-h-14 sm:flex-row sm:items-center sm:justify-start sm:gap-3";
	return (
		<div className="space-y-7">
			<h1 className="page-title pt-1">{t.nav.library}</h1>
			<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
				<Link to="/favorites" className={quick}>
					<IconHeart className="text-[#c0392b] dark:text-[#f28b82]" />
					{t.favorites.title}
				</Link>
				<Link to="/archive" className={quick}>
					<IconArchive className="text-muted" />
					{t.archive.title}
				</Link>
				<Link to="/trash" className={quick}>
					<IconTrash className="text-danger" />
					{t.trash.title}
				</Link>
			</div>
			<section className="space-y-3">
				<h2 className="text-lg font-bold">{t.organize.title}</h2>
				<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
					{ORGANIZE_ITEMS.map((item) => (
						<OrganizeLink key={item.to} item={item} />
					))}
				</div>
			</section>
			<StorageMeter className="border border-border bg-card" />
		</div>
	);
}
