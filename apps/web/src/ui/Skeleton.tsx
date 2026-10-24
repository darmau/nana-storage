import { t } from "../i18n";

/**
 * 骨架屏：首次加载、数据还没回来时按页面最终的形状占位（styles.css 的 .skeleton：延迟 150ms 才淡入，
 * 缓存命中或请求很快时不会闪一下；之后只做 opacity 的呼吸，减少动态效果时关闭）。
 * 纯 CSS 块，不请求任何东西。照片网格直接复用拖动条的 .scrub-placeholder 格子图案，和滚动时的占位一致。
 */
function Skeleton({ className = "", children }: { className?: string; children: React.ReactNode }) {
	return (
		<div role="status" aria-busy="true" aria-label={t.common.loading} className={`skeleton ${className}`}>
			{children}
		</div>
	);
}

const bar = "rounded-md bg-surface";

/** 照片网格（列表视图是一行一个） */
export function GridSkeleton({ view = "grid" }: { view?: "grid" | "list" }) {
	return (
		<Skeleton>
			<div className={`skeleton-fade h-[70vh] ${view === "list" ? "scrub-placeholder-rows" : "scrub-placeholder"}`} />
		</Skeleton>
	);
}

/** 时间线：月份标题 + 照片网格（和 MonthSection 的 h-12 标题对齐） */
export function TimelineSkeleton() {
	return (
		<Skeleton>
			<div className="flex h-12 items-center pl-1">
				<div className={`h-6 w-36 ${bar}`} />
			</div>
			<div className="skeleton-fade scrub-placeholder h-[70vh]" />
		</Skeleton>
	);
}

/** 文件夹卡片（和 FoldersPage 的网格相同的列数） */
export function FolderCardsSkeleton({ count = 14 }: { count?: number }) {
	return (
		<Skeleton className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
			{Array.from({ length: count }, (_, i) => (
				<div key={i} className="space-y-1.5">
					<div className="aspect-square rounded-2xl bg-surface" />
					<div className={`h-4 w-3/4 ${bar}`} />
					<div className={`h-3 w-1/3 ${bar}`} />
				</div>
			))}
		</Skeleton>
	);
}

/** 文件夹的列表视图：一行一个子文件夹 */
export function FolderRowsSkeleton({ count = 6 }: { count?: number }) {
	return (
		<Skeleton className="divide-y divide-border">
			{Array.from({ length: count }, (_, i) => (
				<div key={i} className="flex h-14 items-center gap-3">
					<div className="size-10 rounded-lg bg-surface" />
					<div className={`h-4 w-48 max-w-[50%] ${bar}`} />
				</div>
			))}
		</Skeleton>
	);
}

/** 相册卡片（和 AlbumGrid 相同：左半封面 + 右边 3×3） */
export function AlbumCardsSkeleton({ count = 4 }: { count?: number }) {
	return (
		<Skeleton className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
			{Array.from({ length: count }, (_, i) => (
				<div key={i} className="rounded-3xl border border-border bg-card p-2">
					<div className="aspect-[2/1] rounded-2xl bg-surface" />
					<div className="flex items-center gap-3 px-2 pt-3.5 pb-2">
						<div className={`h-4 w-40 ${bar}`} />
						<div className={`ml-auto h-3 w-16 ${bar}`} />
					</div>
				</div>
			))}
		</Skeleton>
	);
}

/** 人物头像（和 PeoplePage 的“其他人物”网格相同） */
export function PeopleSkeleton({ count = 18 }: { count?: number }) {
	return (
		<Skeleton className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-5 lg:grid-cols-7 xl:grid-cols-9">
			{Array.from({ length: count }, (_, i) => (
				<div key={i} className="flex flex-col items-center gap-1.5">
					<div className="aspect-square w-full max-w-28 rounded-full bg-surface" />
					<div className={`h-4 w-2/3 ${bar}`} />
					<div className={`h-3 w-6 ${bar}`} />
				</div>
			))}
		</Skeleton>
	);
}

/** 重复照片的分组卡片（和 DuplicatesPage 相同：一行缩略图 + 右下角两个按钮） */
export function DuplicateGroupsSkeleton({ count = 3 }: { count?: number }) {
	return (
		<Skeleton className="space-y-3">
			<div className={`h-4 w-56 ${bar}`} />
			{Array.from({ length: count }, (_, i) => (
				<div key={i} className="rounded-2xl border border-border bg-card p-3">
					<div className="flex gap-2 overflow-hidden pb-1">
						{Array.from({ length: 3 }, (_, j) => (
							<div key={j} className="aspect-[4/3] h-28 shrink-0 rounded-xl bg-surface sm:h-36" />
						))}
					</div>
					<div className="mt-2 flex justify-end gap-2">
						<div className="h-9 w-24 rounded-full bg-surface" />
						<div className="h-9 w-28 rounded-full bg-surface" />
					</div>
				</div>
			))}
		</Skeleton>
	);
}
