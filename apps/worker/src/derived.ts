/**
 * 派生文件（缩略图、预览、H.264 预览、裁切或打码过的照片的未裁切、未打码底图 base，以及人脸头像拼图 faces，见 src/people.ts）在 R2 里的 key：d/{assetId}/{role}-{derived_rev}.{ext}。
 * 只有处理这个版本的任务会写这个 key，所以按 key 读到的一定是这个版本的文件（files.ts 据此跳过 D1）。
 */
export const derivedKey = (assetId: string, role: string, rev: number, ext: string) =>
	`d/${assetId}/${role}-${rev}.${ext}`;

export const DERIVED_FILES = {
	thumb: { ext: "webp", mime: "image/webp" },
	preview: { ext: "webp", mime: "image/webp" },
	video_preview: { ext: "mp4", mime: "video/mp4" },
	/** 只有裁切过的照片才有：旋转之后、裁切之前的整张图（长边最多 2048），查看器的编辑界面调整裁切时用 */
	base: { ext: "webp", mime: "image/webp" },
} as const satisfies Record<string, { ext: string; mime: string }>;
