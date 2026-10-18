import { useEffect } from "react";

/**
 * 全屏深色界面（查看器、幻灯片）打开期间，把浏览器 / 独立窗口的状态栏颜色换成它的背景色，关闭后还原。
 * index.html 里按浅色 / 深色各有一个 theme-color，这里临时改它们的 content。
 * 可以嵌套（幻灯片上再开查看器）：最上面的那个生效，全部关闭后恢复原值。
 */
const stack: { color: string }[] = [];
let original: [HTMLMetaElement, string][] = [];

function apply() {
	const top = stack[stack.length - 1];
	for (const [meta, content] of original) meta.content = top ? top.color : content;
}

export function useThemeColor(color: string) {
	useEffect(() => {
		if (stack.length === 0) {
			original = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((m) => [m, m.content]);
		}
		const entry = { color };
		stack.push(entry);
		apply();
		return () => {
			stack.splice(stack.indexOf(entry), 1);
			apply();
		};
	}, [color]);
}
