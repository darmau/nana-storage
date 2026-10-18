/**
 * 界面语言：跟随系统 / 简体中文 / English。和外观一样只是这台设备上的偏好，存在 localStorage（读写失败就当跟随系统）。
 * 语言在页面加载时确定一次，切换后重新加载页面：文案和格式化都是普通的模块级值，不用 Context 层层传递，
 * 非组件代码（上传队列、弹窗）也能直接用。
 */
export const LOCALES = ["zh-CN", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export type LocalePref = Locale | "system";

/** 语言名称用各自的语言写，不翻译：看不懂当前界面的人也能找到自己的语言。 */
export const LOCALE_NAMES: Record<Locale, string> = { "zh-CN": "简体中文", en: "English" };

const KEY = "nana:lang";

export function getLocalePref(): LocalePref {
	try {
		const v = localStorage.getItem(KEY);
		return (LOCALES as readonly string[]).includes(v ?? "") ? (v as Locale) : "system";
	} catch {
		return "system";
	}
}

/** 存下偏好并重新加载页面。存不下（隐私模式等）就不重新加载，免得白刷新一次。 */
export function setLocalePref(pref: LocalePref) {
	try {
		if (pref === "system") localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, pref);
	} catch {
		return;
	}
	location.reload();
}

/** 按浏览器的语言列表取第一个支持的：任何中文都用简体中文，都不支持时用英文。 */
function systemLocale(): Locale {
	const langs = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
	for (const l of langs) {
		const s = l.toLowerCase();
		if (s.startsWith("zh")) return "zh-CN";
		if (s.startsWith("en")) return "en";
	}
	return "en";
}

/** 单元测试固定用简体中文，结果不随运行环境的语言变化。 */
export const locale: Locale = import.meta.env.MODE === "test" ? "zh-CN" : ((p) => (p === "system" ? systemLocale() : p))(getLocalePref());

// 在第一次渲染之前设置：屏幕阅读器的发音和中日韩字形的选择都看它
if (typeof document !== "undefined") document.documentElement.lang = locale;
