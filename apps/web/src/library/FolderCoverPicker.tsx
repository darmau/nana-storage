import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { t } from "../i18n";
import { thumbUrl } from "../timeline/types";
import { IconCheck, IconChevronLeft, IconFolder } from "../ui/icons";
import { Modal } from "./Modal";
import { folderQuery, listQuery } from "./queries";

/**
 * 文件夹封面的选择器：从这个文件夹开始，可以进子文件夹、回上级，点任意一张照片设为封面。
 * 照片走和文件夹页相同的分页接口（每页 500 张，点“加载更多”才读下一页，不自动翻页）；
 * 归档的照片不列出（封面也不显示归档的）。cover 是现在的自定义封面，有的话可以恢复自动封面。
 */
export function FolderCoverPicker({
	folder,
	onPick,
	onClose,
}: {
	folder: { id: string; name: string; cover_asset_id: string | null };
	onPick: (assetId: string | null) => void;
	onClose: () => void;
}) {
	const [current, setCurrent] = useState(folder.id);
	const { data: info } = useQuery(folderQuery(current));
	const photos = useInfiniteQuery(listQuery({ key: ["folderCover", current], path: `/folders/${current}/assets` }));
	const items = photos.data?.pages.flatMap((p) => p.items) ?? [];
	const parent = info?.path.length ? (info.path.length > 1 ? info.path[info.path.length - 2]!.id : "root") : null;
	return (
		<Modal title={t.folders.coverTitle(folder.name)} onClose={onClose} wide>
			<p className="mb-3 text-sm text-muted">{t.folders.coverHint}</p>
			<div className="mb-2 flex min-w-0 items-center gap-2 text-sm">
				{parent && (
					<button className="rounded-md px-2 py-1 hover:bg-surface" onClick={() => setCurrent(parent)} aria-label={t.pickers.up}>
						<IconChevronLeft size={18} />
					</button>
				)}
				<span className="truncate font-medium">{info?.path.map((p) => p.name).join(" / ") || t.pickers.root}</span>
			</div>
			{!!info?.children.length && (
				<ul className="mb-3 max-h-36 space-y-1 overflow-y-auto">
					{info.children.map((f) => (
						<li key={f.id}>
							<button className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm hover:bg-surface" onClick={() => setCurrent(f.id)}>
								<IconFolder size={18} className="shrink-0 text-muted" />
								<span className="truncate">{f.name}</span>
								<span className="shrink-0 text-muted">· {f.count}</span>
							</button>
						</li>
					))}
				</ul>
			)}
			{photos.isSuccess && !items.length && <p className="py-6 text-center text-sm text-muted">{t.folders.coverEmpty}</p>}
			<div className="grid grid-cols-4 gap-1 sm:grid-cols-6">
				{items.map(([id, , , , , , , rev]) => {
					const active = id === folder.cover_asset_id;
					return (
						<button
							key={id}
							type="button"
							aria-pressed={active}
							aria-label={t.folders.coverPick}
							className={`relative aspect-square overflow-hidden rounded-md bg-surface ${active ? "ring-2 ring-accent ring-offset-2 ring-offset-card" : "hover:opacity-80"}`}
							onClick={() => onPick(id)}
						>
							<img src={thumbUrl(id, rev)} alt="" loading="lazy" className="h-full w-full object-cover" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
							{active && (
								<span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-accent-fg">
									<IconCheck size={14} />
								</span>
							)}
						</button>
					);
				})}
			</div>
			{photos.hasNextPage && (
				<button className="btn mt-3 w-full" disabled={photos.isFetchingNextPage} onClick={() => void photos.fetchNextPage()}>
					{t.folders.coverMore}
				</button>
			)}
			{folder.cover_asset_id && (
				<button className="btn mt-4 w-full" onClick={() => onPick(null)}>
					{t.folders.coverAuto}
				</button>
			)}
		</Modal>
	);
}
