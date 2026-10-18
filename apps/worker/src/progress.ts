import { JOB_STALE_MS } from "@nana/shared";
import { guardStub } from "./guard";
import { RETRY_FAILED_MAX } from "./jobs";

/**
 * GET /api/jobs/active：后台处理的进度（设置页显示）。
 *  - 这一批：从现在还没完成的任务里最早创建的那个算起（最多往前 24 小时），已完成 / 失败 / 剩余各多少。
 *  - 速度：最近 10 分钟完成的任务数，用来估算剩余时间。
 *  - 正在处理的（最多 20 个）和排在最前面的（最多 30 个）任务，带文件名。
 *  - 设备端处理的租约（设备名、到期时间）。
 * 只读，几条走索引的查询 + 1 次 UsageGuard 调用；前端的自动刷新有次数上限。
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** ULID 前 10 位是毫秒时间戳 */
export const ulidTime = (id: string) => [...id.slice(0, 10)].reduce((t, ch) => t * 32 + ALPHABET.indexOf(ch), 0);

const RATE_WINDOW_MS = 10 * 60_000;
const BATCH_MAX_AGE_MS = 24 * 3600_000;

export interface ActiveJob {
	id: string;
	asset_id: string;
	kind: string;
	status: "pending" | "running";
	attempts: number;
	started_at: number | null;
	last_error: string | null;
	asset_kind: "photo" | "video" | "live";
	asset_status: string;
	derived_rev: number;
	size: number;
	names: string[];
}

const LIST_SQL = `SELECT j.id, j.asset_id, j.kind, j.status, j.attempts, j.started_at, j.last_error,
		a.kind AS asset_kind, a.status AS asset_status, a.derived_rev,
		(SELECT COALESCE(SUM(size), 0) FROM asset_files f WHERE f.asset_id = j.asset_id AND f.role IN ('original','raw','live_video')) AS size,
		(SELECT json_group_array(original_name) FROM asset_files f WHERE f.asset_id = j.asset_id
			AND f.role IN ('original','raw','live_video') AND f.original_name IS NOT NULL) AS names
	FROM jobs j JOIN assets a ON a.id = j.asset_id`;

export async function jobsOverview(env: Env) {
	const now = Date.now();
	const counts = (await env.DB.prepare(
		`SELECT COALESCE(SUM(status = 'pending'), 0) AS pending,
			COALESCE(SUM(status = 'running' AND started_at >= ?), 0) AS running,
			COALESCE(SUM(status = 'running' AND started_at < ?), 0) AS stuck,
			COALESCE(SUM(status = 'pending' AND attempts > 0), 0) AS retrying,
			MIN(id) AS first
		 FROM jobs WHERE status IN ('pending','running')`,
	)
		.bind(now - JOB_STALE_MS, now - JOB_STALE_MS)
		.first<{ pending: number; running: number; stuck: number; retrying: number; first: string | null }>())!;

	const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'done' AND updated_at >= ?")
		.bind(now - RATE_WINDOW_MS)
		.first<{ n: number }>();

	let batch: { since: number; done: number; failed: number } | null = null;
	if (counts.first) {
		const since = Math.max(ulidTime(counts.first), now - BATCH_MAX_AGE_MS);
		const r = await env.DB.prepare(
			`SELECT COALESCE(SUM(status = 'done'), 0) AS done, COALESCE(SUM(status = 'failed'), 0) AS failed
			 FROM jobs WHERE status IN ('done','failed') AND updated_at >= ?`,
		)
			.bind(since)
			.first<{ done: number; failed: number }>();
		batch = { since, done: r?.done ?? 0, failed: r?.failed ?? 0 };
	}

	const device = await guardStub(env).device();
	const [running, pending] = await env.DB.batch<ActiveJob & { names: string }>([
		env.DB.prepare(`${LIST_SQL} WHERE j.status = 'running' ORDER BY j.started_at LIMIT 20`),
		env.DB.prepare(`${LIST_SQL} WHERE j.status = 'pending' ORDER BY j.updated_at LIMIT 30`),
	]);
	const parse = (rows: (ActiveJob & { names: string })[]) => rows.map((r) => ({ ...r, names: JSON.parse(r.names) as string[] }));

	const { first: _, ...rest } = counts;
	return {
		now,
		counts: rest,
		batch,
		perMinute: (recent?.n ?? 0) / (RATE_WINDOW_MS / 60_000),
		staleAfterMs: JOB_STALE_MS,
		/** 设备端处理接管中：排队的任务由这台设备拉取，不启动容器。 */
		device,
		running: parse(running!.results),
		pending: parse(pending!.results),
	};
}

export interface FailedJob extends ActiveJob {
	updated_at: number;
}

/** 某个条目的任务（任何状态），GET /api/jobs/asset/:id 返回。 */
export interface AssetJob extends Omit<ActiveJob, "status"> {
	status: "pending" | "running" | "done" | "failed";
	updated_at: number;
}

/** 一个条目最多列出这么多个任务（最新的在前）。 */
export const ASSET_JOBS_MAX = 50;

/**
 * GET /api/jobs/asset/:id：一个条目的全部任务，最新的在前（最多 ASSET_JOBS_MAX 个）。
 * 成本防护因为“同一条目反复处理”熔断时，设置页用它列出那个条目做过什么。只读，走 jobs 的 asset_id 索引。
 */
export async function assetJobs(env: Env, assetId: string): Promise<{ staleAfterMs: number; items: AssetJob[] }> {
	const { results } = await env.DB.prepare(
		`${LIST_SQL.replace("j.last_error,", "j.last_error, j.updated_at,")} WHERE j.asset_id = ? ORDER BY j.id DESC LIMIT ?`,
	)
		.bind(assetId, ASSET_JOBS_MAX)
		.all<AssetJob & { names: string }>();
	return { staleAfterMs: JOB_STALE_MS, items: results.map((r) => ({ ...r, names: JSON.parse(r.names) as string[] })) };
}

/** GET /api/jobs/failed：最近失败的任务（最多 RETRY_FAILED_MAX 个，带文件名）和失败总数。 */
export async function failedJobs(env: Env): Promise<{ total: number; items: FailedJob[] }> {
	const [list, count] = await env.DB.batch([
		env.DB.prepare(`${LIST_SQL.replace("j.last_error,", "j.last_error, j.updated_at,")} WHERE j.status = 'failed' ORDER BY j.updated_at DESC LIMIT ?`).bind(
			RETRY_FAILED_MAX,
		),
		env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed'"),
	]);
	const rows = list!.results as (FailedJob & { names: string })[];
	return {
		total: (count!.results[0] as { n: number }).n,
		items: rows.map((r) => ({ ...r, names: JSON.parse(r.names) as string[] })),
	};
}
