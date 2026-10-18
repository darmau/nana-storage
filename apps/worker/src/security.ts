/**
 * 所有响应（包括 SPA 静态资源）都加上这些头。
 * CSP 只允许同源资源：没有第三方脚本、字体、统计。
 * 唯一的例外是地图底图（OpenFreeMap 的样式、瓦片、字形、图标），只放行 connect-src / img-src，
 * 不能加载脚本；它只能看到浏览的地图范围，看不到任何照片。
 */
const MAP_ORIGIN = "https://tiles.openfreemap.org";
const CSP = [
	"default-src 'self'",
	"script-src 'self' 'wasm-unsafe-eval'",
	"style-src 'self' 'unsafe-inline'",
	`img-src 'self' blob: data: ${MAP_ORIGIN}`,
	"media-src 'self' blob:",
	"font-src 'self'",
	`connect-src 'self' ${MAP_ORIGIN}`,
	"worker-src 'self' blob:",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'self'",
	"frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
	"Content-Security-Policy": CSP,
	"Strict-Transport-Security": "max-age=63072000; includeSubDomains",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY",
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
};

/**
 * varyCookie：默认给响应加上 Vary: Cookie（退出登录、cookie 清掉之后，浏览器不会把缓存里的页面数据直接拿出来用）。
 * 照片字节（/api/a/*）和带 hash 的 JS / CSS 不加：它们本来就是 private 的长期缓存，而 Access 的 CF_Authorization
 * 每次会话续期都会换（默认 24 小时），带着 Vary: Cookie 时浏览器会把所有缓存过的缩略图、预览当成另一个版本，全部重新下载。
 * 这些字节不管带不带 Vary 都留在浏览器的磁盘缓存里，Vary 挡不住能接触这台电脑的人。
 */
export function withSecurityHeaders(response: Response, { varyCookie = true }: { varyCookie?: boolean } = {}): Response {
	const res = new Response(response.body, response);
	for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
	// 任何响应都不允许进入共享缓存（CDN）。图片接口会自己设置更长的 private 缓存。
	const cc = res.headers.get("Cache-Control");
	if (!cc || !/\bprivate\b|\bno-store\b/.test(cc)) {
		res.headers.set("Cache-Control", "private, no-cache");
	}
	if (varyCookie) res.headers.append("Vary", "Cookie");
	return res;
}

/** 写请求的 CSRF 检查：必须带自定义头，且 Origin 是本站。 */
export function isSafeMutation(request: Request, appOrigin: string): boolean {
	if (request.method === "GET" || request.method === "HEAD") return true;
	if (request.headers.get("x-requested-with") !== "nana") return false;
	const origin = request.headers.get("origin");
	if (!origin) return false;
	const requestOrigin = new URL(request.url).origin;
	return origin === appOrigin || origin === requestOrigin;
}

export const forbidden = () =>
	withSecurityHeaders(new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain" } }));
