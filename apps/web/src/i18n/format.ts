import { locale } from "./locale";

/** 数字、日期一律按界面语言格式化，不跟随浏览器的语言，免得一个页面里中英混排。 */
const numberFormat = new Intl.NumberFormat(locale);

export const fmtNumber = (n: number) => numberFormat.format(n);
