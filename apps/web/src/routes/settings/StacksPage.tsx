import { useQuery, useQueryClient } from "@tanstack/react-query";
import { STACK_BACKFILL_REQUESTS } from "@nana/shared";
import { useRef, useState } from "react";
import { api, errorText } from "../../api";
import { t } from "../../i18n";
import { invalidateLibrary } from "../../library/actions";
import { useStacksEnabled, setStacksEnabled } from "../../ui/stacks";
import { Group, SettingsHeader } from "./shared";

interface StackState {
	cursor: string;
	done: boolean;
	processed: number;
}

const stateQuery = { queryKey: ["stacks", "state"], queryFn: () => api<StackState>("/stacks/state") };

/**
 * 设置 › 相似照片：时间线折叠的开关（这台设备），以及存量照片的分批补建。
 * 补建只由点击触发：顺序请求，每次一个 chunk（服务端限天数 / 行数），到上限或出错即停，可以再点继续。
 * 全程只读写 D1，不启动容器。
 */
export function StacksPage() {
	const qc = useQueryClient();
	const enabled = useStacksEnabled();
	const state = useQuery(stateQuery);
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [stopped, setStopped] = useState(false);
	const cancel = useRef(false);

	const run = async (reset: boolean) => {
		setRunning(true);
		setError(null);
		setStopped(false);
		cancel.current = false;
		try {
			let r = await api<StackState>("/stacks/rebuild", { method: "POST", json: reset ? { reset: true } : {} });
			qc.setQueryData(stateQuery.queryKey, r);
			for (let i = 1; i < STACK_BACKFILL_REQUESTS && !r.done && !cancel.current; i++) {
				r = await api<StackState>("/stacks/rebuild", { method: "POST", json: {} });
				qc.setQueryData(stateQuery.queryKey, r);
			}
			if (!r.done) setStopped(true);
			// 分组结果变了，时间线等列表重取
			invalidateLibrary(qc);
		} catch (e) {
			setError(errorText(e));
			void qc.invalidateQueries({ queryKey: stateQuery.queryKey });
		} finally {
			setRunning(false);
		}
	};

	const s = state.data;
	const label = running ? t.settings.stacks.running : s?.done ? t.settings.stacks.restart : s && s.processed > 0 ? t.settings.stacks.continue : t.settings.stacks.start;

	return (
		<div className="space-y-8">
			<SettingsHeader title={t.settings.pages.stacks} />
			<Group footer={t.settings.stacks.foldFooter}>
				<label className="flex min-h-12 cursor-pointer items-center gap-3 px-4 py-2 text-sm">
					<input type="checkbox" className="h-4 w-4 accent-accent" checked={enabled} onChange={(e) => setStacksEnabled(qc, e.target.checked)} />
					<span className="flex-1">{t.settings.stacks.foldLabel}</span>
				</label>
			</Group>
			<Group title={t.settings.stacks.backfillTitle} footer={t.settings.stacks.backfillFooter}>
				<div className="space-y-3 p-4">
					{s && (
						<p className="text-sm text-muted">
							{s.done ? t.settings.stacks.done(s.processed) : s.processed > 0 ? t.settings.stacks.progress(s.processed, s.cursor) : " "}
						</p>
					)}
					{stopped && <p className="text-sm text-muted">{t.settings.stacks.stopped}</p>}
					{error && <p className="text-sm text-danger">{error}</p>}
					<div className="flex items-center gap-3">
						<button className="btn" disabled={running || !s} onClick={() => void run(s?.done ?? false)}>
							{label}
						</button>
						{running && (
							<button className="btn" onClick={() => (cancel.current = true)}>
								{t.common.cancel}
							</button>
						)}
					</div>
				</div>
			</Group>
		</div>
	);
}
