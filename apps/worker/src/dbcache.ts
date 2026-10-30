/**
 * D1 读取的两层“缓存”，都不会返回过期数据：
 *
 * 1. 读副本（Sessions API）：每个 /api 请求用一个 D1 会话，读可以落到离用户近的副本上。
 *    前端把每次响应带回的 X-D1-Bookmark 存下来、下次请求带上，会话保证读到的数据不会比这个书签旧
 *    （自己刚写的马上能读到）。没带书签的 GET 从任意副本读，写请求从主库开始。
 *    没有开启读复制时一切照旧走主库，这段代码不起作用也不出错。
 *
 * 2. 条件请求：列表接口按依赖的数据分组（CONDITIONAL），每组一个版本号（cache_versions，迁移 0013 的触发器维护）：
 *    library 只在“可见”的条目（ready 或回收站里的）、相册、文件夹变化时加一，上传和处理的中间状态不改它；
 *    people / smart_sets 是人物和主题自己的表，它们的结果还取决于条目是否可见，所以同时带上 library。
 *    响应带 ETag = 部署版本 + 各组版本；浏览器重新验证时只读这一两行，没变就回 304，不重跑查询、不重传数据。
 *    带部署版本是因为新代码可能改了返回格式。
 *    结果和当前时间有关的接口不能进名单；只在少数情况下和时间有关的（主题正在更新时的 refreshing），
 *    那一次响应设 Cache-Control: no-store，中间件就不给它 ETag（见 noValidator）。
 */

const BOOKMARK_RE = /^[0-9a-f-]{16,128}$/i;

export function openSession(db: D1Database, request: Request): D1DatabaseSession {
	const bookmark = request.headers.get("x-d1-bookmark");
	if (bookmark && BOOKMARK_RE.test(bookmark)) return db.withSession(bookmark);
	return db.withSession(request.method === "GET" ? "first-unconstrained" : "first-primary");
}

export type VersionGroup = "library" | "people" | "smart_sets";

const CONDITIONAL: [RegExp, VersionGroup[]][] = [
	[/^\/api\/timeline\/(buckets|month\/[^/]+)$/, ["library"]],
	[/^\/api\/map\/(points|assets)$/, ["library"]],
	[/^\/api\/folders\/[^/]+(\/assets)?$/, ["library"]],
	[/^\/api\/(bursts|albums)\/[^/]+\/assets$/, ["library"]],
	[/^\/api\/albums(\/[^/]+)?$/, ["library"]],
	[/^\/api\/(favorites|archive|trash)\/assets$/, ["library"]],
	[/^\/api\/search(\/cameras)?$/, ["library"]],
	[/^\/api\/folders\/[^/]+\/people(\/[^/]+\/assets)?$/, ["library", "people"]],
	[/^\/api\/people(\/[^/]+(\/assets)?)?$/, ["library", "people"]],
	[/^\/api\/smart-sets(\/[^/]+(\/(assets|suggestions|examples))?)?$/, ["library", "smart_sets"]],
];

/** 这个请求能不能走条件请求；能的话返回它依赖的版本组。 */
export function conditionalGroups(method: string, pathname: string): VersionGroup[] | null {
	if (method !== "GET") return null;
	return CONDITIONAL.find(([re]) => re.test(pathname))?.[1] ?? null;
}

export async function dataEtag(env: Env, groups: VersionGroup[]): Promise<string> {
	const { results } = await env.DB.prepare(`SELECT name, v FROM cache_versions WHERE name IN (${groups.map(() => "?").join(",")})`)
		.bind(...groups)
		.all<{ name: string; v: number }>();
	const v = new Map(results.map((r) => [r.name, r.v]));
	return `W/"${env.CF_VERSION_METADATA?.id ?? "dev"}-${groups.map((g) => v.get(g) ?? 0).join(".")}"`;
}

/** 结果暂时和时间有关时，这一次响应不带 ETag（中间件看到 no-store 就不加），浏览器也不存。 */
export const NO_STORE = "private, no-store";
export const noValidator = (res: Response) => /\bno-store\b/.test(res.headers.get("Cache-Control") ?? "");

export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
	if (!ifNoneMatch) return false;
	return ifNoneMatch.split(",").some((t) => t.trim() === etag || t.trim() === "*");
}
