/**
 * 线性图标（24×24，描边 1.8）。全部内联 SVG，不加载任何外部资源。
 * 图标本身对读屏隐藏，含义由按钮的 aria-label 或旁边的文字提供。
 */
interface IconProps {
	size?: number;
	className?: string;
	/** 实心（收藏的心形、已选中等） */
	filled?: boolean;
}

function icon(body: React.ReactNode, opts: { fillable?: boolean } = {}) {
	return function Icon({ size = 20, className, filled }: IconProps) {
		return (
			<svg
				width={size}
				height={size}
				viewBox="0 0 24 24"
				fill={opts.fillable && filled ? "currentColor" : "none"}
				stroke="currentColor"
				strokeWidth={1.8}
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
				focusable="false"
				className={className}
			>
				{body}
			</svg>
		);
	};
}

export const IconPhotos = icon(
	<>
		<rect x="3" y="3" width="18" height="18" rx="2" />
		<circle cx="9" cy="9" r="2" />
		<path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
	</>,
);
export const IconSearch = icon(
	<>
		<circle cx="11" cy="11" r="8" />
		<path d="m21 21-4.3-4.3" />
	</>,
);
export const IconCompass = icon(
	<>
		<circle cx="12" cy="12" r="9" />
		<path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" />
	</>,
);
export const IconLibrary = icon(
	<>
		<path d="M12 2 2 7l10 5 10-5-10-5Z" />
		<path d="m2 17 10 5 10-5" />
		<path d="m2 12 10 5 10-5" />
	</>,
);
/** 相册：一本带照片的书（和资料库的图层图标区分开，二者同时出现在移动端标签栏） */
export const IconAlbum = icon(
	<>
		<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" />
		<circle cx="10" cy="8" r="2" />
		<path d="m20 13.7-2.1-2.1a2 2 0 0 0-2.8 0L9.7 17" />
	</>,
);
/** 连拍：叠在一起的几张 */
export const IconBurst = icon(
	<>
		<rect x="7" y="7" width="14" height="14" rx="2" />
		<path d="M4 16V6a2 2 0 0 1 2-2h10" />
	</>,
);
export const IconMap = icon(
	<>
		<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" />
		<path d="M9 4v14M15 6v14" />
	</>,
);
export const IconFolder = icon(
	<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
);
export const IconFolderMove = icon(
	<>
		<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
		<path d="M9 13h6M13 10.5 15.5 13 13 15.5" />
	</>,
);
export const IconGrid = icon(
	<>
		<rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
		<rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
		<rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
		<rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
	</>,
);
export const IconList = icon(<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />);
/** 排序：上下两个箭头 */
export const IconSort = icon(<path d="M7 4v16M3.5 7.5 7 4l3.5 3.5M17 20V4M13.5 16.5 17 20l3.5-3.5" />);
export const IconHeart = icon(
	<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z" />,
	{ fillable: true },
);
export const IconTrash = icon(
	<>
		<path d="M3 6h18" />
		<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
		<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
	</>,
);
export const IconUpload = icon(
	<>
		<path d="M12 3v12" />
		<path d="m7 8 5-5 5 5" />
		<path d="M5 21h14" />
	</>,
);
export const IconDownload = icon(
	<>
		<path d="M12 3v12" />
		<path d="m7 10 5 5 5-5" />
		<path d="M5 21h14" />
	</>,
);
export const IconSettings = icon(
	<>
		<path d="M20 7h-9M14 17H5" />
		<circle cx="17" cy="17" r="3" />
		<circle cx="7" cy="7" r="3" />
	</>,
);
/** 成本防护 */
export const IconShield = icon(<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3Z" />);
/** 使用统计 */
export const IconChart = icon(<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />);
/** 存储空间（侧边栏底部的统计） */
export const IconStorage = icon(
	<>
		<ellipse cx="12" cy="5.5" rx="8" ry="2.5" />
		<path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" />
	</>,
);
/** 后台处理 */
export const IconActivity = icon(<path d="M3 12h4l3-8 4 16 3-8h4" />);
export const IconLogout = icon(
	<>
		<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
		<path d="m10 17-5-5 5-5M5 12h11" />
	</>,
);
export const IconSun = icon(
	<>
		<circle cx="12" cy="12" r="4" />
		<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
	</>,
);
export const IconMoon = icon(<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />);
/** 跟随系统 */
export const IconMonitor = icon(
	<>
		<rect x="3" y="4" width="18" height="12" rx="2" />
		<path d="M8 20h8M12 16v4" />
	</>,
);
export const IconCheck = icon(<path d="M20 6 9 17l-5-5" />);
export const IconClose = icon(<path d="M18 6 6 18M6 6l12 12" />);
export const IconPlus = icon(<path d="M12 5v14M5 12h14" />);
export const IconMinus = icon(<path d="M5 12h14" />);
export const IconMore = icon(
	<>
		<circle cx="5" cy="12" r="1" fill="currentColor" />
		<circle cx="12" cy="12" r="1" fill="currentColor" />
		<circle cx="19" cy="12" r="1" fill="currentColor" />
	</>,
);
export const IconEdit = icon(<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />);
export const IconChevronLeft = icon(<path d="m15 18-6-6 6-6" />);
export const IconChevronRight = icon(<path d="m9 18 6-6-6-6" />);
export const IconChevronUp = icon(<path d="m18 15-6-6-6 6" />);
export const IconChevronDown = icon(<path d="m6 9 6 6 6-6" />);
export const IconPlay = icon(<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none" />);
export const IconPause = icon(
	<>
		<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
		<rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
	</>,
);
export const IconShuffle = icon(
	<>
		<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
	</>,
);
export const IconSlideshow = icon(
	<>
		<rect x="2.5" y="4" width="19" height="14" rx="2" />
		<path d="m10 8.5 4.5 2.5-4.5 2.5z" />
		<path d="M8 21h8" />
	</>,
);
export const IconRotate = icon(
	<>
		<path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
		<path d="M21 3v5h-5" />
	</>,
);
/** 裁切：两个交叠的直角 */
export const IconCrop = icon(<path d="M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14" />);
/** 打码：画笔扫过的一片毛玻璃 */
export const IconBlur = icon(
	<>
		<path d="M14.5 4.5 19.5 9.5 11 18H6v-5z" />
		<path d="M3 21h4M10 21h1M14 21h1M18 21h3" />
	</>,
);
export const IconUndo = icon(<path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />);
export const IconRestore = icon(
	<>
		<path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
		<path d="M3 3v5h5" />
	</>,
);
/** 归档：带盖的收纳盒 */
export const IconArchive = icon(
	<>
		<rect x="2" y="3" width="20" height="5" rx="1" />
		<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
		<path d="M10 12h4" />
	</>,
);
export const IconInfo = icon(
	<>
		<circle cx="12" cy="12" r="10" />
		<path d="M12 16v-4M12 8h.01" />
	</>,
);
/** 警告：主题里标签和分类器矛盾的样本 */
export const IconAlert = icon(
	<>
		<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
		<path d="M12 9v4M12 17h.01" />
	</>,
);
export const IconCalendar = icon(
	<>
		<rect x="3" y="4" width="18" height="18" rx="2" />
		<path d="M16 2v4M8 2v4M3 10h18" />
	</>,
);
export const IconPin = icon(
	<>
		<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
		<circle cx="12" cy="10" r="3" />
	</>,
);
export const IconCamera = icon(
	<>
		<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
		<circle cx="12" cy="13" r="3" />
	</>,
);
export const IconFile = icon(
	<>
		<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
		<path d="M14 2v6h6" />
	</>,
);
export const IconRuler = icon(
	<>
		<rect x="3" y="3" width="18" height="18" rx="2" />
		<path d="M3 9h4M3 15h4M9 3v4M15 3v4" />
	</>,
);
/** Live Photo：和 iOS 一样，实心圆点 + 圆环 + 外圈 20 个圆点（周长 2π×9.6 ÷ 20 ≈ 3.016，零长度虚线配圆头画成点） */
export const IconLive = icon(
	<>
		<circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
		<circle cx="12" cy="12" r="5.6" />
		<circle cx="12" cy="12" r="9.6" strokeDasharray="0 3.016" />
	</>,
);
/** Live Photo 自动播放已关闭：IconLive 加一道斜线 */
export const IconLiveOff = icon(
	<>
		<circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
		<circle cx="12" cy="12" r="5.6" />
		<circle cx="12" cy="12" r="9.6" strokeDasharray="0 3.016" />
		<path d="M4 4l16 16" />
	</>,
);
/** 原图：方框里的 HD */
export const IconHd = icon(
	<>
		<rect x="2.5" y="5" width="19" height="14" rx="2.5" />
		<path d="M7 9.5v5M7 12h3.2M10.2 9.5v5M13.6 9.5v5h1.4a2.5 2.5 0 0 0 0-5z" />
	</>,
);
/** 品牌标志：七叶光圈，中心的七边形是「光」。和 public/favicon.svg 同一套几何。 */
/** 相似：两张交叠的照片 + 闪光 */
export const IconSimilar = icon(
	<>
		<rect x="3" y="7" width="12" height="12" rx="2" />
		<path d="M7 7V5a2 2 0 0 1 2-2h4" />
		<path d="m3 15 3-3 5 5" />
		<path d="M18.5 3v4M16.5 5h4M19 11v3M17.5 12.5h3" />
	</>,
);
/** 人物：一前一后两个人 */
export const IconPeople = icon(
	<>
		<circle cx="9" cy="8" r="3.5" />
		<path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
		<path d="M15.5 4.6a3.5 3.5 0 0 1 0 6.8" />
		<path d="M18 14.2a6.5 6.5 0 0 1 3.5 5.8" />
	</>,
);
/** 隐藏：划掉的眼睛 */
export const IconEyeOff = icon(
	<>
		<path d="M9.9 5.2A9.6 9.6 0 0 1 12 5c6 0 9.5 7 9.5 7a16.4 16.4 0 0 1-2.6 3.4" />
		<path d="M6.3 6.3C3.8 8 2.5 12 2.5 12s3.5 7 9.5 7a9.3 9.3 0 0 0 5.7-1.9" />
		<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
		<path d="m3 3 18 18" />
	</>,
);
/** 合并：两条线汇成一条 */
export const IconMerge = icon(
	<>
		<path d="M6 3v3a6 6 0 0 0 12 0V3" />
		<path d="M12 12v9" />
		<path d="m8.5 17.5 3.5 3.5 3.5-3.5" />
	</>,
);
/** 重复：两张完全叠在一起的照片 */
export const IconDuplicate = icon(
	<>
		<rect x="8" y="8" width="13" height="13" rx="2" />
		<path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
	</>,
);

export const IconLogo = ({ size = 28 }: { size?: number }) => (
	<svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="shrink-0">
		<rect width="32" height="32" rx="8" className="fill-fg" />
		<g fill="none" strokeWidth={1.6} strokeLinecap="round" className="stroke-bg">
			<circle cx="16" cy="16" r="10" />
			<path d="M16 12L25.97 16.8M19.13 13.51L21.59 24.29M19.9 16.89L13 25.54M17.74 19.6L6.67 19.6M14.26 19.6L7.37 10.95M12.1 16.89L14.56 6.1M12.87 13.51L22.84 8.71" />
		</g>
		<path d="M16 12L19.13 13.51L19.9 16.89L17.74 19.6L14.26 19.6L12.1 16.89L12.87 13.51Z" fill="#f2b544" />
	</svg>
);
