import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { fmtNumber, t } from "../i18n";
import { invalidateLibrary } from "../library/actions";
import { Modal } from "../library/Modal";
import type { Page, SmartSetDetail } from "../library/queries";
import { previewUrl, thumbUrl } from "../timeline/types";
import { IconCheck, IconClose } from "../ui/icons";

/**
 * 逐张判断主题的建议：一次一张，回答“是 / 否”，分别记成正例 / 反例（Y / N 键，S 跳过）。
 * 建议在打开时请求一页（最多 500 张），答完不自动再要下一批；分类器要等“更新”之后才会学到这些标记。
 * 只预加载下一张的预览。
 */
export function SmartSetReview({
	set,
	order,
	onClose,
	onRefresh,
}: {
	set: Pick<SmartSetDetail, "id" | "name">;
	order: "uncertain" | "score";
	onClose: () => void;
	onRefresh: () => void;
}) {
	const qc = useQueryClient();
	const review = useQuery({
		queryKey: ["smart-sets", set.id, "review", order],
		queryFn: () => api<Page>(`/smart-sets/${set.id}/suggestions?order=${order}`),
		staleTime: 0,
		gcTime: 0,
	});
	const [i, setI] = useState(0);
	const [answered, setAnswered] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const items = review.data?.items ?? [];
	const item = items[i];
	const next = items[i + 1];
	const score = review.data?.scores?.[i];

	useEffect(() => {
		if (next) new Image().src = previewUrl(next[0], next[7]);
	}, [next]);

	const close = () => {
		if (answered) invalidateLibrary(qc);
		onClose();
	};
	const answer = async (label: 1 | -1) => {
		if (!item || busy) return;
		setBusy(true);
		setError(null);
		try {
			await api(`/smart-sets/${set.id}/examples`, { method: "POST", json: { ids: [item[0]], label } });
			setAnswered((n) => n + 1);
			setI((n) => n + 1);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			const k = e.key.toLowerCase();
			if (k === "y") void answer(1);
			else if (k === "n") void answer(-1);
			else if (k === "s" && item) setI((n) => n + 1);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	return (
		<Modal title={t.topics.reviewTitle(set.name)} onClose={close}>
			{review.isPending && <p className="py-10 text-center text-sm text-muted">{t.topics.reviewLoading}</p>}
			{review.error && <p className="text-sm text-danger">{errorText(review.error)}</p>}
			{review.isSuccess && !item && (
				<div className="space-y-4 py-6 text-center">
					<p className="text-sm text-muted">{answered ? t.topics.reviewDone(answered) : t.topics.reviewNone}</p>
					<div className="flex justify-center gap-2">
						<button className="btn" onClick={close}>
							{t.common.close}
						</button>
						{answered > 0 && (
							<button
								className="btn-primary"
								onClick={() => {
									onRefresh();
									close();
								}}
							>
								{t.topics.refresh}
							</button>
						)}
					</div>
				</div>
			)}
			{item && (
				<div className="space-y-4">
					<p className="text-center text-sm">
						{t.topics.reviewQuestion(set.name)}
						<span className="ml-1 text-xs tabular-nums text-muted">
							{fmtNumber(i + 1)} / {fmtNumber(items.length)}
						</span>
					</p>
					<div
						className="relative mx-auto flex h-[min(50dvh,24rem)] items-center justify-center overflow-hidden rounded-2xl bg-surface"
						style={{ backgroundImage: `url(${thumbUrl(item[0], item[7])})`, backgroundSize: "contain", backgroundPosition: "center", backgroundRepeat: "no-repeat" }}
					>
						<img key={item[0]} src={previewUrl(item[0], item[7])} alt="" draggable={false} className="max-h-full max-w-full object-contain" />
						{score !== undefined && (
							<span className="absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-xs tabular-nums text-white">
								{t.topics.reviewScore(Math.round(score * 100))}
							</span>
						)}
					</div>
					{error && <p className="text-center text-xs text-danger">{error}</p>}
					<div className="grid grid-cols-2 gap-2">
						<button className="btn justify-center" disabled={busy} onClick={() => void answer(-1)}>
							<IconClose size={18} />
							{t.actions.no}
						</button>
						<button className="btn-primary justify-center" disabled={busy} onClick={() => void answer(1)}>
							<IconCheck size={18} />
							{t.actions.yes}
						</button>
					</div>
					<div className="flex items-center justify-between text-xs text-muted">
						<span>{t.topics.reviewKeys}</span>
						<button className="hover:text-fg" disabled={busy} onClick={() => setI((n) => n + 1)}>
							{t.topics.reviewSkip}
						</button>
					</div>
				</div>
			)}
		</Modal>
	);
}
