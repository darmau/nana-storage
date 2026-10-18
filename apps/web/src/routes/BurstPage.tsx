import { useInfiniteQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { t } from "../i18n";
import { LibraryList } from "../library/LibraryList";
import { type ListSource, listQuery } from "../library/queries";
import { formatDay } from "../timeline/format";
import { IconBurst } from "../ui/icons";
import { useDocumentTitle } from "../ui/title";

/** 一组连拍的全部照片，按拍摄顺序排列。可以在这里挑出要保留的，其余的多选后删除。 */
export function BurstPage() {
	useDocumentTitle(t.burst.title);
	const { assetId } = useParams({ strict: false }) as { assetId: string };
	const source: ListSource = { key: ["burst", assetId], path: `/bursts/${assetId}/assets` };
	// 和下面的网格共用同一个分页查询
	const query = useInfiniteQuery(listQuery(source));
	const items = query.data?.pages.flatMap((p) => p.items) ?? [];
	const day = items[0]?.[4] ?? null;

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-3 pt-1">
				<IconBurst size={24} className="shrink-0 text-muted" />
				<div className="min-w-0">
					<h1 className="text-xl font-bold tracking-tight sm:text-2xl">{t.burst.heading(items.length)}</h1>
					{items.length > 0 && <p className="text-sm text-muted">{formatDay(day)}</p>}
				</div>
			</div>
			<LibraryList key={assetId} source={source} context={{ kind: "library" }} groupByDay={false} empty={t.burst.empty} />
		</div>
	);
}
