import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { folderQuery } from "../library/queries";
import { IconUpload } from "../ui/icons";
import { alertDialog } from "../ui/confirm";
import { filesFromDrop, MAX_DROP_FILES } from "./drop";
import { uploadTo } from "./picker";
import { t } from "../i18n";

/** 当前页面的上传目标：文件夹页面是这个文件夹，其他页面（时间线、相册等）都是根目录。顶栏的“上传”也用它。 */
export function useUploadTarget(): string | null {
	return useRouterState({ select: (s) => /^\/folders\/([0-9A-Z]{26})$/.exec(s.location.pathname)?.[1] ?? null });
}

const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");

/**
 * 整个窗口都可以拖入文件上传，挂在外壳上。拖进来时盖一层提示，写明会传到哪里。
 * 拖进来的文件夹按原来的目录结构在目标下建子文件夹（和“上传文件夹”一样）。
 * 页面内部的拖动（比如拖一张缩略图）不算。
 */
export function DropUpload() {
	const target = useUploadTarget();
	const qc = useQueryClient();
	const info = useQuery({ ...folderQuery(target ?? "root"), enabled: !!target });
	const [over, setOver] = useState(false);
	const targetRef = useRef(target);
	targetRef.current = target;

	useEffect(() => {
		let depth = 0;
		let internal = false;
		const reset = () => {
			depth = 0;
			setOver(false);
		};
		const onDragStart = () => {
			internal = true;
		};
		const onDragEnd = () => {
			internal = false;
		};
		const onEnter = (e: DragEvent) => {
			if (internal || !hasFiles(e)) return;
			depth++;
			setOver(true);
		};
		const onLeave = (e: DragEvent) => {
			if (internal || !hasFiles(e)) return;
			depth = Math.max(0, depth - 1);
			if (!depth) setOver(false);
		};
		const onOver = (e: DragEvent) => {
			if (internal || !hasFiles(e)) return;
			// 不 preventDefault 的话浏览器会直接打开这个文件
			e.preventDefault();
			e.dataTransfer!.dropEffect = "copy";
		};
		const onDrop = (e: DragEvent) => {
			if (internal || !hasFiles(e)) return;
			e.preventDefault();
			reset();
			const folderId = targetRef.current;
			void filesFromDrop(e.dataTransfer!).then((dropped) => {
				if (dropped.length >= MAX_DROP_FILES)
					void alertDialog(t.upload.tooManyFiles, t.upload.tooManyFilesBody(MAX_DROP_FILES));
				return uploadTo(
					qc,
					folderId,
					dropped.map((d) => d.file),
					{ keepStructure: true, paths: dropped.map((d) => d.path) },
				);
			});
		};

		window.addEventListener("dragstart", onDragStart);
		window.addEventListener("dragend", onDragEnd);
		window.addEventListener("dragenter", onEnter);
		window.addEventListener("dragleave", onLeave);
		window.addEventListener("dragover", onOver);
		window.addEventListener("drop", onDrop);
		return () => {
			window.removeEventListener("dragstart", onDragStart);
			window.removeEventListener("dragend", onDragEnd);
			window.removeEventListener("dragenter", onEnter);
			window.removeEventListener("dragleave", onLeave);
			window.removeEventListener("dragover", onOver);
			window.removeEventListener("drop", onDrop);
		};
	}, [qc]);

	if (!over) return null;

	const label = !target ? t.upload.dropRoot : info.data ? info.data.path.map((p) => p.name).join(" / ") : "…";

	return (
		<div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-bg/70 p-6 backdrop-blur-sm" aria-hidden>
			<div className="flex w-full max-w-md flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-accent bg-card px-6 py-10 text-center shadow-[0_8px_32px_rgb(0_0_0/0.18)]">
				<IconUpload size={32} className="text-accent" />
				<p className="text-base font-semibold">{t.upload.dropTitle}</p>
				<p className="max-w-full truncate text-sm text-muted">{t.upload.dropTarget(label)}</p>
				<p className="text-xs text-muted">{t.upload.dropHint}</p>
			</div>
		</div>
	);
}
