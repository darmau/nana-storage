import { formatDay } from "../timeline/format";
import { idsOf, type TimelineItem } from "../timeline/types";
import { IconCheck } from "../ui/icons";
import { useSelection } from "./selection";
import { t } from "../i18n";

/**
 * 日期标题。左边的勾选框一次选上（或取消）这一天的全部照片：
 * 悬停时出现，多选时一直显示（触屏没有悬停，长按选中一张后就能看到）。
 */
export function DayHeader({ day, top, items }: { day: string | null; top: number; items: TimelineItem[] }) {
	const { selected, active, setMany } = useSelection();
	const all = items.length > 0 && items.every((it) => selected.has(it[0]));
	return (
		<h3 className="group/day absolute left-0 flex h-8 items-center text-sm font-semibold text-fg/80" style={{ top }}>
			<button
				type="button"
				aria-label={all ? t.library.deselectDay(formatDay(day)) : t.library.selectDay(formatDay(day))}
				aria-pressed={all}
				onClick={() =>
					setMany(
						items.flatMap(idsOf),
						!all,
					)
				}
				className={`-ml-1 flex h-8 w-8 items-center justify-center rounded-full transition hover:bg-surface ${
					all || active ? "opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover/day:opacity-100"
				}`}
			>
				<span
					className={`flex h-5 w-5 items-center justify-center rounded-full ${
						all ? "bg-accent text-accent-fg" : "border-2 border-muted text-transparent"
					}`}
				>
					<IconCheck size={13} />
				</span>
			</button>
			<span className={`transition-transform ${all || active ? "" : "-translate-x-6 group-hover/day:translate-x-0"}`}>{formatDay(day)}</span>
		</h3>
	);
}
