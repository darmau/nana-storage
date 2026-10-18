/**
 * 外观：跟随系统 / 浅色 / 深色。只是这台设备上的偏好，存在 localStorage（读写失败就当跟随系统）。
 * 页面加载时由 public/theme.js 在渲染前套用；这里负责设置页里的切换。
 */
export type ThemePref = "system" | "light" | "dark";

const KEY = "nana:theme";
/** 和 styles.css 里浅色 / 深色的 --bg 一致 */
const COLORS = { light: "#fafaf8", dark: "#0e0f11" } as const;

export function getThemePref(): ThemePref {
	try {
		const v = localStorage.getItem(KEY);
		return v === "light" || v === "dark" ? v : "system";
	} catch {
		return "system";
	}
}

export function setThemePref(pref: ThemePref) {
	try {
		if (pref === "system") localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, pref);
	} catch {
		// 存不下也照样在当前页面生效
	}
	const root = document.documentElement;
	if (pref === "system") delete root.dataset.theme;
	else root.dataset.theme = pref;
	// 状态栏颜色：跟随系统时还原成按 media 区分的两个值
	for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
		meta.content = pref !== "system" ? COLORS[pref] : meta.media.includes("dark") ? COLORS.dark : COLORS.light;
	}
}

/** 当前实际是不是深色（地图底图据此选样式）。 */
export function isDarkTheme(): boolean {
	const pref = getThemePref();
	if (pref !== "system") return pref === "dark";
	return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}
