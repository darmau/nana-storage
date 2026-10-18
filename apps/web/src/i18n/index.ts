import { en } from "./en";
import { locale } from "./locale";
import { type Messages, zhCN } from "./zh-CN";

export { fmtNumber } from "./format";
export { getLocalePref, LOCALE_NAMES, LOCALES, locale, setLocalePref, type Locale, type LocalePref } from "./locale";
export type { Messages };

/**
 * 当前语言的全部文案：`t.upload.paused`、`t.upload.uploading(n)`。
 * 两种语言都打进主包里，省掉启动时多一次请求；以后语言多了再改成按需加载。
 */
export const t: Messages = locale === "en" ? en : zhCN;
