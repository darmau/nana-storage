/**
 * 描述语义搜索（Cloudflare AI Search，built-in storage + Items API）：
 * 照片描述写进 D1 后，同步 upload 到 AI Search 实例；查询时按语义召回照片 id，
 * 再由调用方用 D1 过滤可见（deleted_at IS NULL、status='ready'），结果和 FTS 搜索一样按拍摄时间返回。
 *
 * 实例绑定 DESC_SEARCH（wrangler.jsonc 的 ai_search_namespaces，namespace = nana，实例 nana-descriptions，需在 Cloudflare 先创建）。
 * 本地开发没有这个绑定：descSearch 返回 undefined，写入/搜索都直接跳过（和 FACE_INDEX 同样的做法）。
 *
 * 成本：写入 $0.75/百万 token（一次性），查询 $0.75/千次（每月前 1000 次免费），存储 $2/GB·月。
 * 只由用户操作触发（写描述 / 搜索 / 一次性同步 / 删除），没有 Cron、没有自触发。
 */

/** AI Search 实例绑定的最小类型（真实类型由 `wrangler types` 生成；这里只声明用到的部分）。 */
interface DescSearchInstance {
	search(req: {
		query: string;
		ai_search_options?: {
			retrieval?: { max_num_results?: number; retrieval_type?: "hybrid" | "vector" | "keyword"; match_threshold?: number };
		};
	}): Promise<{ data?: DescChunk[]; chunks?: DescChunk[]; results?: DescChunk[] }>;
	items: {
		upload(name: string, content: string): Promise<{ id: string; key: string }>;
		delete(key: string): Promise<unknown>;
	};
}

interface DescChunk {
	score?: number;
	text?: string;
	item?: { key?: string };
}

/** 命名空间绑定（ai_search_namespaces）：DESC_SEARCH 是命名空间句柄，get(实例名) 拿到实例。 */
interface DescSearchNamespace {
	get(name: string): DescSearchInstance | undefined;
}

/** 实例名（在 nana 命名空间下）。 */
const DESC_INSTANCE = "nana-descriptions";

/** 绑定缺失（本地开发、测试）或实例不存在时返回 undefined。 */
export function descSearch(env: Env): DescSearchInstance | undefined {
	try {
		return (env as unknown as { DESC_SEARCH?: DescSearchNamespace }).DESC_SEARCH?.get(DESC_INSTANCE);
	} catch {
		return undefined;
	}
}

/** 照片 id ↔ AI Search 条目 key。照片 id 是 ULID（26 个 [0-9A-Z]），直接拼 .md 即可。 */
export const descKey = (assetId: string) => `${assetId}.md`;

/** 从搜索结果 chunk 里取照片 id（key 去掉 .md）。 */
function chunkAssetId(chunk: DescChunk): string | null {
	const key = chunk?.item?.key;
	if (typeof key !== "string" || !key.endsWith(".md")) return null;
	return key.slice(0, -3);
}

/**
 * 描述变化时同步进 AI Search：非空 upload、空/删 delete。失败只记日志（不影响写描述本身），
 * 和 FACE_INDEX 一样是尽力而为；漏掉的那条要等下一次描述变化或一次性同步补上。
 */
export async function syncDesc(env: Env, assetId: string, description: string | null): Promise<void> {
	const index = descSearch(env);
	if (!index) return;
	try {
		if (description) await index.items.upload(descKey(assetId), description);
		else await index.items.delete(descKey(assetId));
	} catch (e) {
		console.error(JSON.stringify({ event: "desc_search_sync_failed", assetId, error: String(e).slice(0, 200) }));
	}
}

/** 永久删除条目时调用：尽力删掉 AI Search 里的条目（失败也没关系，搜索结果会用 D1 过滤）。 */
export async function deleteDescs(env: Env, assetIds: string[]): Promise<void> {
	const index = descSearch(env);
	if (!index) return;
	for (const id of assetIds) {
		try {
			await index.items.delete(descKey(id));
		} catch {
			// 忽略
		}
	}
}

/** 语义搜索：召回最像的 topK 个照片 id（按相关度，不保证可见），调用方再用 D1 过滤。 */
export async function searchDescriptions(env: Env, query: string, topK = 50): Promise<string[]> {
	const index = descSearch(env);
	if (!index) return [];
	try {
		const res = await index.search({
			query,
			ai_search_options: { retrieval: { max_num_results: topK, retrieval_type: "hybrid", match_threshold: 0.3 } },
		});
		const chunks = res?.data ?? res?.chunks ?? res?.results ?? [];
		const ids: string[] = [];
		for (const c of chunks) {
			const id = chunkAssetId(c);
			if (id && !ids.includes(id)) ids.push(id);
		}
		return ids;
	} catch (e) {
		console.error(JSON.stringify({ event: "desc_search_failed", error: String(e).slice(0, 200) }));
		return [];
	}
}
