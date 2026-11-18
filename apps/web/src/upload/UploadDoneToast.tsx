import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { errorText } from "../api";
import { t } from "../i18n";
import { addToAlbum } from "../library/actions";
import { AlbumPicker } from "../library/Pickers";
import { IconAlbum, IconCheck, IconClose } from "../ui/icons";
import { useUploads } from "./UploadStatus";
import { uploader } from "./uploader";

/**
 * 拖到窗口（首页 → 根目录）上传完成后，右下角提示“上传成功”，下面给一个“添加到相册”按钮。
 * 点开复用相册选择器（library/Pickers.tsx 的 AlbumPicker），把刚才上传的照片加进指定相册，
 * 和 Google Photos 的做法一样。显示它的时候 UploadPanel 让位（见 UploadPanel 里对 dropDone 的判断）。
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
			<AlbumPicker
				onClose={() => setPicking(false)}
				onPick={(albumId) => {
					setPicking(false);
					const ids = done.assetIds;
					void addToAlbum(qc, albumId, ids)
						.then(() => {
							setMessage(t.upload.doneAdded);
							uploader.dismissDropDone();
						})
						.catch((e) => setMessage(t.upload.doneAddFailed(errorText(e))));
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
						<IconAlbum size={18} />
						{t.upload.doneAddToAlbum}
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
