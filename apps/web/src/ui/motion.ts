import type { RouterOptions } from "@tanstack/react-router";

type ViewTransitionOptions = Exclude<NonNullable<RouterOptions<any, any>["defaultViewTransition"]>, boolean>;

/**
 * 页面切换动效（View Transitions API，交给路由在切换时调用）：
 *  - 进入下一层（打开相册、文件夹、设置分页）：新页面从右边推进来；
 *  - 返回（浏览器后退、回到上一层）：反过来；
 *  - 切换顶层页面（底部标签、侧边栏）、设置的分页之间（都在同一个页面里展示）：淡入淡出。
 * 顶栏、侧边栏、底部标签有自己的 view-transition-name，不跟着页面动。
 *
 * 只改了地址参数（打开查看器 ?a=、筛选 ?type= …）不做动画。浏览器自己已经播过动画
 * （Safari 的左滑返回）、系统开启“减少动态效果”时也不做。
 * 浏览器不支持带类型的 View Transition 时整个关掉：否则路由会对每次导航（包括查看器里切换照片）都做默认的淡入淡出。
 */

/** 顶层页面：从这里进出都只淡入淡出（侧边栏里的每一项） */
const TOP = new Set(["/", "/albums", "/search", "/people", "/smart-sets", "/map", "/stats", "/library", "/favorites", "/archive", "/trash", "/duplicates", "/similar-groups", "/folders/root", "/settings"]);

const under = (path: string, p: string) => path === p || path.startsWith(`${p}/`);

const depth = (path: string) => (path === "/" ? 0 : path.replace(/\/$/, "").split("/").length - 1);

let uaTransition = false;
if (typeof window !== "undefined") {
	window.addEventListener("popstate", (e) => {
		uaTransition = (e as PopStateEvent & { hasUAVisualTransition?: boolean }).hasUAVisualTransition === true;
	});
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function pageTransitionTypes(
	from: { pathname: string; state: { __TSR_index?: number } } | undefined,
	to: { pathname: string; state: { __TSR_index?: number } },
): string[] | false {
	const ua = uaTransition;
	uaTransition = false;
	if (!from || from.pathname === to.pathname || ua || reducedMotion()) return false;
	if (under(from.pathname, "/settings") && under(to.pathname, "/settings")) return ["page-fade"];
	// 浏览器的后退
	if ((to.state.__TSR_index ?? 0) < (from.state.__TSR_index ?? 0)) return ["page-back"];
	if (TOP.has(to.pathname)) return ["page-fade"];
	return depth(to.pathname) < depth(from.pathname) ? ["page-back"] : ["page-forward"];
}

const supported =
	typeof document !== "undefined" && typeof document.startViewTransition === "function" && !!window.CSS?.supports?.("selector(:active-view-transition-type(a))");

export const pageTransition: ViewTransitionOptions | false = supported
	? { types: ({ fromLocation, toLocation }) => pageTransitionTypes(fromLocation, toLocation) }
	: false;
