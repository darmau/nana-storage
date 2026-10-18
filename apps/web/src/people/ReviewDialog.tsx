import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { Modal } from "../library/Modal";
import { thumbUrl } from "../timeline/types";
import { IconCheck, IconClose } from "../ui/icons";
import { type FaceRef, FaceAvatar, invalidatePeople, type Person, personName } from "./model";
import { t } from "../i18n";

/**
 * “确认更多照片”（iOS 的“查看更多”、Google 的“同一个人还是不同的人”）：一次一张脸，回答“是 / 不是”。
 * 候选在打开时请求一次（最多 30 张），答完不自动再要下一批；可以用 Y / N 键。
 */
export function ReviewDialog({ person, onClose }: { person: Person; onClose: () => void }) {
	const qc = useQueryClient();
	const review = useQuery({
		queryKey: ["people", person.id, "review"],
		queryFn: () => api<{ items: (FaceRef & { score: number })[]; unavailable?: boolean }>(`/people/${person.id}/review`),
		staleTime: 0,
		gcTime: 0,
	});
	const [i, setI] = useState(0);
	const [answered, setAnswered] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const items = review.data?.items ?? [];
	const face = items[i];

	const close = () => {
		if (answered) invalidatePeople(qc);
		onClose();
	};
	const answer = async (yes: boolean) => {
		if (!face || busy) return;
		setBusy(true);
		setError(null);
		try {
			await api(`/faces/${face.id}/${yes ? "assign" : "reject"}`, { method: "POST", json: { personId: person.id } });
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
			if (e.key === "y" || e.key === "Y") void answer(true);
			else if (e.key === "n" || e.key === "N") void answer(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	const name = personName(person);
	return (
		<Modal title={t.people.review} onClose={close}>
			{review.isPending && <p className="py-10 text-center text-sm text-muted">{t.people.searching}</p>}
			{review.error && <p className="text-sm text-danger">{errorText(review.error)}</p>}
			{review.data?.unavailable && <p className="text-sm text-muted">{t.people.reviewUnavailable}</p>}
			{review.isSuccess && !face && !review.data.unavailable && (
				<div className="space-y-4 py-6 text-center">
					<p className="text-sm text-muted">{answered ? t.people.reviewDone(answered) : t.people.noMore(name)}</p>
					<button className="btn-primary" onClick={close}>
						{t.people.done}
					</button>
				</div>
			)}
			{face && (
				<div className="space-y-5">
					<p className="text-center text-sm">
						{t.people.isThisBefore}
						<span className="font-semibold">{name}</span>
						{t.people.isThisAfter}
						<span className="ml-1 text-xs tabular-nums text-muted">
							{i + 1} / {items.length}
						</span>
					</p>
					<div className="flex items-center justify-center gap-4">
						<FaceAvatar face={person.cover} size={72} className="opacity-80" />
						<FaceAvatar key={face.id} face={face} size={144} className="ring-2 ring-accent ring-offset-2 ring-offset-card" />
						<img
							src={thumbUrl(face.assetId, face.rev)}
							alt=""
							className="h-24 w-24 rounded-xl bg-surface object-cover"
							draggable={false}
						/>
					</div>
					{error && <p className="text-center text-xs text-danger">{error}</p>}
					<div className="grid grid-cols-2 gap-2">
						<button className="btn justify-center" disabled={busy} onClick={() => void answer(false)}>
							<IconClose size={18} />
							{t.people.no}
						</button>
						<button className="btn-primary justify-center" disabled={busy} onClick={() => void answer(true)}>
							<IconCheck size={18} />
							{t.people.yes}
						</button>
					</div>
					<button className="mx-auto block text-xs text-muted hover:text-fg" disabled={busy} onClick={() => setI((n) => n + 1)}>
						{t.people.skip}
					</button>
				</div>
			)}
		</Modal>
	);
}
