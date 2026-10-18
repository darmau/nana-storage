import { useState } from "react";

export interface Bar {
	key: string;
	value: number;
	/** 两端的刻度文字 */
	edge: string;
}

/**
 * 单序列柱状图（统计数据页的容器时长、拍摄时间共用）：悬停 / 点按一根柱子，上面那行显示它的数值（caption），
 * 没有选中时显示 idle（通常是峰值）。柱子多时去掉间隔，手机宽度下也放得下几百根。
 * bars 换了一组（比如切换时间范围）时由调用方换 key 重置选中。
 */
export function BarChart({ bars, caption, idle }: { bars: Bar[]; caption: (bar: Bar) => React.ReactNode; idle: React.ReactNode }) {
	const [hover, setHover] = useState<number | null>(null);
	const max = Math.max(...bars.map((b) => b.value), 1);
	const shown = hover === null ? null : bars[hover];
	const dense = bars.length > 60;
	return (
		<div className="rounded-lg border border-border p-3">
			<div className="h-5 truncate text-sm tabular-nums">{shown ? caption(shown) : <span className="text-muted">{idle}</span>}</div>
			<div className={`mt-2 flex h-32 items-end border-b border-border ${dense ? "" : "gap-0.5"}`} onMouseLeave={() => setHover(null)}>
				{bars.map((b, i) => (
					<div
						key={b.key}
						className="flex h-full min-w-0 flex-1 items-end"
						onMouseEnter={() => setHover(i)}
						onClick={() => setHover(i)}
						aria-label={`${b.edge} ${b.value}`}
					>
						<div
							className={`w-full ${dense ? "rounded-t-sm" : "rounded-t"} ${hover === i ? "bg-accent" : "bg-accent/70"}`}
							style={{ height: b.value > 0 ? `max(2px, ${(b.value / max) * 100}%)` : 0 }}
						/>
					</div>
				))}
			</div>
			{bars.length > 0 && (
				<div className="mt-1 flex justify-between text-xs text-muted tabular-nums">
					<span>{bars[0]!.edge}</span>
					<span>{bars.at(-1)!.edge}</span>
				</div>
			)}
		</div>
	);
}
