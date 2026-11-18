import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { errorText } from "../api";
import { t } from "../i18n";
import { batch } from "../library/actions";
import { FolderPicker } from "../library/Pickers";
import { IconCheck, IconClose, IconFolder } from "../ui/icons";
import { useUploads } from "./UploadStatus";
import { uploader } from "./uploader";

/**
 * 拖到窗口（首页 → 根目录）上传完成后，右下角提示“上传成功”，下面给一个“移动到文件夹”按钮。
 * 点开复用文件夹选择器（library/Pickers.tsx 的 FolderPicker），把刚才上传的照片移进指定文件夹。
 * 显示它的时候 UploadPanel 让位（见 UploadPanel 里对 dropDone 的判断）。
 */
export function UploadDoneToast() {
	const snap = useUploads();
	const qc = useQueryClient();
	const [picking, setPicking] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const done = snap.dropDone;

	useEffect(() => {
		if (!message) return;
		const timer = setTimeout(() => setMessage(null), 4000);
		return () => clearTimeout(timer);
	}, [message]);

	if (picking && done) {
		return (
			<FolderPicker
				onClose={() => setPicking(false)}
				onPick={(folderId) => {
					setPicking(false);
					const ids = done.assetIds;
					void batch(qc, ids, { action: "move", folderId })
						.then(() => {
							setMessage(t.upload.doneMoved);
							uploader.dismissDropDone();
						})
						.catch((e) => setMessage(t.upload.doneMoveFailed(errorText(e))));
				}}
			/>
		);
	}

	return (
		<>
			{done && (
				<section
					aria-label={t.upload.doneTitle}
					className="pop-in fixed inset-x-2 bottom-[calc(var(--tabbar-h)+0.5rem)] z-50 rounded-2xl border border-border bg-card p-4 shadow-[0_8px_32px_rgb(0_0_0/0.18)] sm:left-auto sm:right-4 sm:w-[340px] md:bottom-4"
				>
					<div className="flex items-start gap-3">
						<span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ok/15 text-ok">
							<IconCheck size={18} />
						</span>
						<div className="min-w-0 flex-1">
							<p className="text-sm font-semibold">{t.upload.doneTitle}</p>
							<p className="text-xs text-muted">{t.upload.doneCount(done.assetIds.length)}</p>
						</div>
						<button className="icon-btn h-8 w-8 shrink-0" aria-label={t.common.close} onClick={() => uploader.dismissDropDone()}>
							<IconClose size={16} />
						</button>
					</div>
					<button className="btn-primary mt-3 w-full" onClick={() => setPicking(true)}>
						<IconFolder size={18} />
						{t.upload.doneMoveToFolder}
					</button>
				</section>
			)}
			{message && (
				<p
					role="status"
					className="pop-in fixed bottom-[calc(var(--tabbar-h)+1rem)] left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-full bg-fg px-4 py-2 text-sm text-bg shadow-lg md:bottom-6 md:left-[calc(50%+var(--sidebar-w)/2)]"
				>
					{message}
				</p>
			)}
		</>
	);
}
