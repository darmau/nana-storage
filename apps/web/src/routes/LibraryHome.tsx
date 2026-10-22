import { Link } from "@tanstack/react-router";
import { t } from "../i18n";
import { StorageMeter } from "../library/StorageMeter";
import { IconArchive, IconHeart, IconTrash } from "../ui/icons";
import { useDocumentTitle } from "../ui/title";

/**
 * 资料库首页（移动端底部“资料库”标签的落点；桌面端这些入口在侧边栏里）。
 * 只放别处没有的入口（收藏、归档、回收站）：相册、文件夹有自己的标签，人物、重复照片在探索页里，不在这里重复。
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
			<StorageMeter className="border border-border bg-card" />
		</div>
	);
}
