import { useEffect } from "react";
import { t } from "../i18n";

const APP = t.app.name;

/**
 * 网页标题：“当前页面 - 那时”，在浏览器标签、历史记录和书签里分辨自己在哪一页。
 * title 为空（还在加载）时先显示“那时”；页面卸载时恢复成“那时”。
 */
export function useDocumentTitle(title: string | null | undefined) {
	useEffect(() => {
		document.title = title ? `${title} - ${APP}` : APP;
	}, [title]);
	useEffect(
		() => () => {
			document.title = APP;
		},
		[],
	);
}
