import { useQuery } from "@tanstack/react-query";
import { formatBytes } from "../timeline/format";
import { IconStorage } from "../ui/icons";
import { storageSummaryQuery } from "./queries";
import { t } from "../i18n";

/**
 * 存储空间统计：所有文件的占用空间（包括缩略图、预览和回收站）、照片数（包括 Live Photo）、视频数。
 * 显示在侧边栏底部和资料库首页（移动端）。加载失败时不显示，不重试、不打扰。
 */
export function StorageMeter({ className = "" }: { className?: string }) {
	const { data } = useQuery(storageSummaryQuery);
	if (!data) return null;
	return (
		<div className={`flex items-start gap-3 rounded-2xl px-4 py-3 text-sm ${className}`}>
			<IconStorage className="mt-0.5 shrink-0 text-muted" />
			<span className="min-w-0 space-y-0.5">
				<span className="block font-semibold tabular-nums">{t.library.storageUsed(formatBytes(data.bytes))}</span>
				<span className="block text-xs tabular-nums text-muted">
					{t.library.storageCounts(data.photos, data.videos)}
				</span>
			</span>
		</div>
	);
}
