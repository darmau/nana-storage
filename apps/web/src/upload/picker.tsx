import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { folderQuery } from "../library/queries";
import { alertDialog } from "../ui/confirm";
import type { MenuItem } from "../ui/ContextMenu";
import { IconFolder, IconUpload } from "../ui/icons";
import { uploader } from "./uploader";
import { t } from "../i18n";

/**
 * 把文件加进上传队列，传到 folderId（null 是根目录，不放进文件夹）。先取目标文件夹的路径用来显示；
 * 文件夹不存在或加载失败就提示，不上传。paths 和 files 一一对应（拖进来的文件夹），给了就按它保留目录结构。
 */
export async function uploadTo(
	qc: QueryClient,
	folderId: string | null,
	files: File[],
	opts: { keepStructure: boolean; paths?: string[] },
) {
	if (!files.length) return;
	let folderLabel = "";
	if (folderId) {
		try {
			const data = await qc.fetchQuery(folderQuery(folderId));
			folderLabel = data.path.map((p) => p.name).join(" / ");
		} catch {
			await alertDialog(t.upload.cannotUpload, t.upload.folderUnavailable);
			return;
		}
	}
	uploader.add(files, { folderId, folderLabel, ...opts });
}

type Kind = "files" | "dir";
let open: ((kind: Kind, folderId: string | null) => void) | null = null;

/**
 * 直接打开系统的选择器。必须在点击事件里同步调用，否则浏览器不弹。
 * 浏览器的选择器不能同时选文件和文件夹，所以分成两种；选文件夹时在目标下按原来的目录结构建子文件夹。
 */
export const pickUpload = (kind: Kind, folderId: string | null) => open?.(kind, folderId);

const MENU_LABELS = {
	none: () => [t.upload.menuFiles, t.upload.menuDir],
	folder: () => [t.upload.menuFilesToFolder, t.upload.menuDirToFolder],
	here: () => [t.upload.menuFilesHere, t.upload.menuDirHere],
};

/** 上传菜单的两项（顶栏“上传”、文件夹卡片的右键菜单）。place：菜单项里怎么说目标（不说 / “到这个文件夹” / “到这里”）。 */
export const uploadMenuItems = (folderId: string | null, place: keyof typeof MENU_LABELS = "none"): MenuItem[] => {
	const [files, dir] = MENU_LABELS[place]();
	return [
		{ label: files!, icon: <IconUpload size={18} />, onSelect: () => pickUpload("files", folderId) },
		{ label: dir!, icon: <IconFolder size={18} />, onSelect: () => pickUpload("dir", folderId) },
	];
};

/** 两个隐藏的 file input，挂在外壳上，pickUpload() 借用它们。 */
export function UploadPicker() {
	const qc = useQueryClient();
	const filesRef = useRef<HTMLInputElement>(null);
	const dirRef = useRef<HTMLInputElement>(null);
	const target = useRef<string | null>(null);

	useEffect(() => {
		open = (kind, folderId) => {
			target.current = folderId;
			(kind === "dir" ? dirRef : filesRef).current?.click();
		};
		return () => {
			open = null;
		};
	}, []);

	const onChange = (input: HTMLInputElement, keepStructure: boolean) => {
		const files = [...(input.files ?? [])];
		input.value = "";
		void uploadTo(qc, target.current, files, { keepStructure });
	};

	return (
		<>
			<input ref={filesRef} type="file" multiple hidden onChange={(e) => onChange(e.currentTarget, false)} />
			<input ref={dirRef} type="file" multiple hidden {...({ webkitdirectory: "" } as object)} onChange={(e) => onChange(e.currentTarget, true)} />
		</>
	);
}
