export interface AssetFile {
	role: string;
	mime: string;
	size: number;
	original_name: string | null;
}

export interface AssetDetail {
	id: string;
	kind: "photo" | "video" | "live";
	status: string;
	taken_at: number | null;
	tz_offset_min: number | null;
	local_day: string | null;
	width: number | null;
	height: number | null;
	duration_ms: number | null;
	lat: number | null;
	lon: number | null;
	camera: string | null;
	lens: string | null;
	description: string | null;
	favorite: number;
	derived_rev: number;
	rotation: number;
	/** 裁切框（0–1，相对于旋转之后的整张图），四个都为 null 表示没有裁切 */
	crop_x: number | null;
	crop_y: number | null;
	crop_w: number | null;
	crop_h: number | null;
	/** 打码的笔画（shared 的 encodeMask），null 表示没有打码 */
	mask: string | null;
	/** 预览图生成时的长边上限 */
	preview_edge: number | null;
	meta_locked: number;
	/** 连拍组 ID，不是连拍时为 null */
	burst_id: string | null;
	/** 照片类型位标志（TRAIT） */
	traits: number;
	jobs_active: number;
	files: AssetFile[];
	/** 所在文件夹的路径，从根目录下的第一层到直接所在的文件夹；在根目录时为空 */
	folder_path: { id: string; name: string }[];
}
