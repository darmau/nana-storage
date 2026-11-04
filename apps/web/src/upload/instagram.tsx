import type { QueryClient } from "@tanstack/react-query";
import { INSTAGRAM_FOLDER } from "@nana/shared";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError, errorText } from "../api";
import { t } from "../i18n";
import { invalidateLibrary } from "../library/actions";
import { armLibrarySync } from "../library/sync";

/**
 * 从 Instagram 导入（服务端 apps/worker/src/instagram.ts）：粘贴一个公开帖子的链接，
 * 先 resolve 读出每张图的地址和文件名，再一张一张 item（同一时间只有一个请求，不重试；
 * 失败的再导入一次就能补上）。导入过的（按 Instagram 的媒体 ID，resolve 带回 existing）直接算重复、不发请求。
 * 关掉弹窗就不再发剩下的请求。
 */
interface Resolved {
	folderId: string;
	takenAt: number;
	videos: number;
	items: { mediaId: string; url: string; name: string; existing: string | null }[];
}

type State =
	| { step: "input"; error?: string }
	| { step: "resolving" }
	| { step: "importing"; done: number; total: number }
	| { step: "done"; folderId: string; imported: number; duplicates: number; failed: number; videos: number; error?: string };

export function openInstagramImport(qc: QueryClient, openFolder: (folderId: string) => void) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const close = () =>
		setTimeout(() => {
			root.unmount();
			host.remove();
		}, 140);
	root.render(<ImportDialog qc={qc} openFolder={openFolder} onClose={close} />);
}

function ImportDialog({ qc, openFolder, onClose }: { qc: QueryClient; openFolder: (id: string) => void; onClose: () => void }) {
	const [state, setState] = useState<State>({ step: "input" });
	const [url, setUrl] = useState("");
	const [closing, setClosing] = useState(false);
	const cancelled = useRef(false);
	const ref = useRef<HTMLFormElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const finish = () => {
		if (closing) return;
		cancelled.current = true;
		setClosing(true);
		onClose();
	};

	useEffect(() => {
		const prev = document.activeElement as HTMLElement | null;
		inputRef.current?.focus();
		const onKey = (e: KeyboardEvent) => {
			const dialogs = document.querySelectorAll('[aria-modal="true"]');
			if (dialogs[dialogs.length - 1] !== ref.current || e.key !== "Escape") return;
			e.stopImmediatePropagation();
			finish();
		};
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			prev?.focus?.();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const run = async () => {
		const link = url.trim();
		if (!link) return;
		setState({ step: "resolving" });
		const tzOffsetMin = -new Date().getTimezoneOffset();
		let post: Resolved;
		try {
			post = await api<Resolved>("/imports/instagram/resolve", { method: "POST", json: { url: link, tzOffsetMin } });
		} catch (e) {
			if (!cancelled.current) setState({ step: "input", error: errorText(e) });
			return;
		}
		let imported = 0;
		let duplicates = 0;
		let failed = 0;
		let error: string | undefined;
		armLibrarySync();
		for (const [i, { existing, ...item }] of post.items.entries()) {
			if (cancelled.current) break;
			if (existing) {
				duplicates++;
				continue;
			}
			setState({ step: "importing", done: i, total: post.items.length });
			try {
				const r = await api<{ status: "imported" | "duplicate" }>("/imports/instagram/item", {
					method: "POST",
					json: { ...item, folderId: post.folderId, takenAt: post.takenAt, tzOffsetMin },
				});
				if (r.status === "duplicate") duplicates++;
				else imported++;
			} catch (e) {
				failed++;
				error = errorText(e);
				// 成本防护触发了：剩下的也一样会被拒绝
				if (e instanceof ApiError && e.code === "guard tripped") {
					failed += post.items.length - i - 1;
					break;
				}
			}
		}
		if (imported) {
			invalidateLibrary(qc);
			armLibrarySync();
		}
		if (!cancelled.current) setState({ step: "done", folderId: post.folderId, imported, duplicates, failed, videos: post.videos, error });
	};

	const busy = state.step === "resolving" || state.step === "importing";
	return (
		<div
			className={`fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px] ${closing ? "fade-out" : "fade-in"}`}
			onClick={() => !busy && finish()}
		>
			<form
				ref={ref}
				role="alertdialog"
				aria-modal="true"
				aria-labelledby="ig-title"
				className={`w-full max-w-sm rounded-3xl bg-card p-5 text-fg shadow-2xl ${closing ? "fade-out" : "pop-in"}`}
				onClick={(e) => e.stopPropagation()}
				onSubmit={(e) => {
					e.preventDefault();
					if (state.step === "input") void run();
					else if (state.step === "done") finish();
				}}
			>
				<h2 id="ig-title" className="text-lg font-bold">
					{t.upload.igTitle}
				</h2>
				{state.step === "input" && (
					<>
						<p className="mt-2 text-sm text-muted">{t.upload.igHint(INSTAGRAM_FOLDER)}</p>
						<input
							ref={inputRef}
							className="field mt-4 w-full"
							type="url"
							inputMode="url"
							autoComplete="off"
							value={url}
							placeholder={t.upload.igPlaceholder}
							aria-label={t.upload.igTitle}
							onChange={(e) => setUrl(e.target.value)}
							onKeyDown={(e) => e.stopPropagation() /* 不触发页面上的快捷键 */}
						/>
						{state.error && (
							<p role="alert" className="mt-2 text-sm text-danger">
								{state.error}
							</p>
						)}
					</>
				)}
				{state.step === "resolving" && <p className="mt-2 text-sm text-muted">{t.upload.igResolving}</p>}
				{state.step === "importing" && (
					<>
						<p className="mt-2 text-sm tabular-nums" aria-live="polite">
							{t.upload.igProgress(state.done, state.total)}
						</p>
						<div className="mt-3 h-1.5 overflow-hidden rounded-full bg-border">
							<div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${(state.done / state.total) * 100}%` }} />
						</div>
						<p className="mt-2 text-xs text-muted">{t.upload.igStopping}</p>
					</>
				)}
				{state.step === "done" && (
					<>
						<p className="mt-2 text-sm">{t.upload.igDone(state.imported, state.duplicates, state.failed)}</p>
						{state.videos > 0 && <p className="mt-1 text-sm text-muted">{t.upload.igVideosSkipped(state.videos)}</p>}
						{state.error && (
							<p role="alert" className="mt-2 text-sm text-danger">
								{state.error}
							</p>
						)}
					</>
				)}
				<div className="mt-5 flex justify-end gap-2">
					{state.step === "done" ? (
						<>
							<button
								type="button"
								className="btn"
								onClick={() => {
									openFolder(state.folderId);
									finish();
								}}
							>
								{t.upload.igOpenFolder}
							</button>
							<button type="submit" className="btn-primary">
								{t.common.gotIt}
							</button>
						</>
					) : (
						<>
							<button type="button" className="btn" onClick={finish}>
								{t.common.cancel}
							</button>
							{state.step === "input" && (
								<button type="submit" className="btn-primary" disabled={!url.trim()}>
									{t.upload.igStart}
								</button>
							)}
						</>
					)}
				</div>
			</form>
		</div>
	);
}
