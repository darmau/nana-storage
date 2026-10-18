import { locale, t } from "../i18n";

/** "2026-10" → 当月的标题（"2026年10月" / "October 2026"） */
export function formatMonth(month: string): string {
	if (month === "unknown") return t.date.unknown;
	const [y, m] = month.split("-").map(Number);
	return t.date.month(new Date(Date.UTC(y!, m! - 1, 1)));
}

/** "2026-10-12" → 日期标题，今年的不写年份 */
export function formatDay(day: string | null): string {
	if (!day) return t.date.unknown;
	const [y, m, d] = day.split("-").map(Number);
	return t.date.day(new Date(Date.UTC(y!, m! - 1, d!)), new Date().getFullYear() !== y);
}

export function formatDuration(ms: number | null): string {
	if (!ms) return "";
	const s = Math.round(ms / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = String(s % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** 按拍摄地时区显示；时区未知时按浏览器时区。 */
export function formatTakenAt(takenAt: number | null, tzOffsetMin: number | null): string {
	if (!takenAt) return t.date.unknown;
	if (tzOffsetMin === null) {
		return new Date(takenAt).toLocaleString(locale, { dateStyle: "full", timeStyle: "short" });
	}
	const local = new Date(takenAt + tzOffsetMin * 60_000);
	const text = local.toLocaleString(locale, { timeZone: "UTC", dateStyle: "full", timeStyle: "short" });
	const sign = tzOffsetMin >= 0 ? "+" : "-";
	const abs = Math.abs(tzOffsetMin);
	return t.date.withOffset(text, `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`);
}

export function formatBytes(n: number): string {
	if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
	if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
	if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(2)} GB`;
	return `${(n / 1024 ** 4).toFixed(2)} TB`;
}

/** 列表视图用：按拍摄地时区的短日期时间（“2026/10/14 18:30”这类，随界面语言）。 */
export function formatTakenShort(takenAt: number | null, tzOffsetMin: number | null): string {
	if (!takenAt) return t.date.unknown;
	const d = tzOffsetMin === null ? new Date(takenAt) : new Date(takenAt + tzOffsetMin * 60_000);
	return d.toLocaleString(locale, { timeZone: tzOffsetMin === null ? undefined : "UTC", dateStyle: "medium", timeStyle: "short" });
}

/** 上传、修改这类按浏览器时区的时间（短格式） */
export function formatDateTime(ms: number): string {
	return ms ? new Date(ms).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : "–";
}

/** 查看器标题用：按拍摄地时区拆成“日期”和“时间”两行。 */
export function formatTakenParts(takenAt: number | null, tzOffsetMin: number | null): { date: string; time: string } {
	if (!takenAt) return { date: t.date.unknown, time: "" };
	const d = tzOffsetMin === null ? new Date(takenAt) : new Date(takenAt + tzOffsetMin * 60_000);
	const timeZone = tzOffsetMin === null ? undefined : "UTC";
	return {
		date: d.toLocaleDateString(locale, { timeZone, year: "numeric", month: "long", day: "numeric", weekday: "short" }),
		time: d.toLocaleTimeString(locale, { timeZone, hour: "2-digit", minute: "2-digit" }),
	};
}
