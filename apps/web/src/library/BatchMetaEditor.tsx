import { lazy, Suspense, useState } from "react";
import { t } from "../i18n";
import { OFFSETS, offsetLabel, parseLatLon } from "../viewer/InfoPanel";
import type { BatchAction } from "./actions";
import { Modal } from "./Modal";

// 地图库比较大，用到时才加载
const MapPicker = lazy(() => import("../map/MapPicker").then((m) => ({ default: m.MapPicker })));

type Tab = "time" | "location";
type TimeMode = "set" | "shift";

const browserTz = () => -new Date().getTimezoneOffset();

/**
 * 批量修改拍摄时间和地点。时间可以统一设成同一个时刻，也可以整体平移（相机时钟不准、忘了改时区）。
 * 改过的字段会被锁定，后台重新处理时不会覆盖。
 */
export function BatchMetaEditor({
	count,
	onApply,
	onClose,
}: {
	count: number;
	onApply: (action: BatchAction, done: (r: { changed: number }) => string) => void;
	onClose: () => void;
}) {
	const [tab, setTab] = useState<Tab>("time");
	const [picking, setPicking] = useState(false);

	const [mode, setMode] = useState<TimeMode>("shift");
	const [local, setLocal] = useState("");
	const [tz, setTz] = useState(browserTz);
	const [later, setLater] = useState(true);
	const [days, setDays] = useState("0");
	const [hours, setHours] = useState("0");
	const [minutes, setMinutes] = useState("0");
	const [text, setText] = useState("");

	const offsets = OFFSETS.includes(tz) ? OFFSETS : [...OFFSETS, tz].sort((a, b) => a - b);
	const num = (v: string) => (/^\d{1,6}$/.test(v.trim()) ? Number(v) : NaN);
	const delta = (later ? 1 : -1) * (num(days) * 1440 + num(hours) * 60 + num(minutes));
	const deltaOk = Number.isFinite(delta) && delta !== 0 && Math.abs(delta) <= 100 * 366 * 1440;
	const parsed = parseLatLon(text);

	const apply = () => {
		if (tab === "location") {
			if (parsed) onApply({ action: "set-location", location: parsed }, (r) => t.meta.locationChanged(r.changed));
		} else if (mode === "set") {
			if (local) onApply({ action: "set-time", takenAt: { local, tzOffsetMin: tz } }, (r) => t.meta.timeSet(r.changed));
		} else if (deltaOk) {
			onApply({ action: "shift-time", deltaMin: delta, fallbackTzOffsetMin: browserTz() }, (r) => t.meta.timeShifted(r.changed, Math.max(0, count - r.changed)));
		}
	};
	const ready = tab === "location" ? !!parsed : mode === "set" ? !!local : deltaOk;

	const seg = (on: boolean) => `h-9 flex-1 rounded-full text-sm font-medium transition ${on ? "bg-card text-fg shadow-sm" : "text-muted hover:text-fg"}`;
	const radio = "flex items-start gap-2.5 rounded-xl border border-border p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft/40";

	return (
		<Modal title={t.meta.title(count)} onClose={onClose}>
			<div className="mb-4 flex rounded-full bg-surface p-1" role="tablist">
				<button role="tab" aria-selected={tab === "time"} className={seg(tab === "time")} onClick={() => setTab("time")}>
					{t.meta.tabTime}
				</button>
				<button role="tab" aria-selected={tab === "location"} className={seg(tab === "location")} onClick={() => setTab("location")}>
					{t.meta.tabLocation}
				</button>
			</div>

			{tab === "time" ? (
				<div className="space-y-3 text-sm">
					<label className={radio}>
						<input type="radio" name="mode" className="mt-1 accent-accent" checked={mode === "shift"} onChange={() => setMode("shift")} />
						<span className="min-w-0 flex-1 space-y-2">
							<span className="block font-medium">{t.meta.shift}</span>
							<span className="block text-xs text-muted">{t.meta.shiftHint}</span>
							{mode === "shift" && (
								<span className="flex flex-wrap items-center gap-2">
									<select className="field h-9 bg-bg" value={later ? "1" : "0"} onChange={(e) => setLater(e.target.value === "1")} aria-label={t.meta.direction}>
										<option value="1">{t.meta.later}</option>
										<option value="0">{t.meta.earlier}</option>
									</select>
									{(
										[
											[days, setDays, t.meta.days],
											[hours, setHours, t.meta.hours],
											[minutes, setMinutes, t.meta.minutes],
										] as const
									).map(([v, set, unit]) => (
										<span key={unit} className="flex items-center gap-1">
											<input
												className="field h-9 w-16 bg-bg text-right tabular-nums"
												inputMode="numeric"
												value={v}
												onChange={(e) => set(e.target.value)}
												onFocus={(e) => e.target.select()}
												aria-label={unit}
												aria-invalid={Number.isNaN(num(v))}
											/>
											{unit}
										</span>
									))}
								</span>
							)}
						</span>
					</label>
					<label className={radio}>
						<input type="radio" name="mode" className="mt-1 accent-accent" checked={mode === "set"} onChange={() => setMode("set")} />
						<span className="min-w-0 flex-1 space-y-2">
							<span className="block font-medium">{t.meta.setSame}</span>
							<span className="block text-xs text-muted">{t.meta.setSameHint}</span>
							{mode === "set" && (
								<>
									<input type="datetime-local" step={1} className="field w-full bg-bg" value={local} onChange={(e) => setLocal(e.target.value)} />
									<select className="field w-full bg-bg" value={tz} onChange={(e) => setTz(Number(e.target.value))} aria-label={t.meta.timezone}>
										{offsets.map((o) => (
											<option key={o} value={o}>
												{offsetLabel(o)}
											</option>
										))}
									</select>
								</>
							)}
						</span>
					</label>
				</div>
			) : (
				<div className="space-y-3 text-sm">
					<input
						className="field w-full bg-bg"
						placeholder={t.meta.latLonPlaceholder}
						value={text}
						onChange={(e) => setText(e.target.value)}
						aria-invalid={!!text && !parsed}
					/>
					{text && !parsed && <p className="text-xs text-danger">{t.meta.latLonInvalid}</p>}
					<div className="flex flex-wrap gap-2">
						<button className="btn" onClick={() => setPicking(true)}>
							{t.meta.pickOnMap}
						</button>
						<button
							className="btn text-danger"
							onClick={() => onApply({ action: "set-location", location: null }, (r) => t.meta.locationCleared(r.changed))}
						>
							{t.meta.clearLocation}
						</button>
					</div>
				</div>
			)}

			<p className="mt-4 text-xs text-muted">{t.meta.lockedHint}</p>
			<div className="mt-4 flex justify-end gap-2">
				<button className="btn" onClick={onClose}>
					{t.common.cancel}
				</button>
				<button className="btn-primary" disabled={!ready} onClick={apply}>
					{t.meta.applyTo(count)}
				</button>
			</div>

			{picking && (
				<Suspense fallback={null}>
					<MapPicker
						initial={parsed}
						onClose={() => setPicking(false)}
						onPick={(loc) => {
							setPicking(false);
							setText(`${loc.lat}, ${loc.lon}`);
						}}
					/>
				</Suspense>
			)}
		</Modal>
	);
}
