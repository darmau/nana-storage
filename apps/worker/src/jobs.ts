import {
	CONSUMER_BUDGET_MS,
	JOB_STALE_MS,
	MAX_JOB_ATTEMPTS,
	RESUME_BATCH,
	SLOT_WAIT_MS,
	UPLOAD_ACTIVE_MS,
	type JobKind,
	type JobMessage,
} from "@nana/shared";
import { guardStub } from "./guard";
import { processorStub } from "./processor";
import { ulid } from "./ulid";

/**
 * 队列消费者。规则（见 CLAUDE.md）：
 *  - D1 jobs 表是唯一真实状态；消息只是“去看看这个任务”的通知。
 *  - 消费者从不往队列里投递新消息。失败重试只用平台的 msg.retry()（受 max_retries 限制）。
 *  - 每个任务最多尝试 MAX_JOB_ATTEMPTS 次，然后标记 failed，只能手动重试。
 *  - 熔断打开时直接 ack，任务留在 pending，恢复时再分批补发。
 *  - 每个任务先从 UsageGuard 拿一个容器槽位（独占一个 Processor），用完归还。
 *    等不到槽位就返回 busy：消息延迟后重新投递，不算任务的尝试次数（但算队列的 max_retries，所以它要够大，
 *    否则积压几千个任务时消息会在等槽位时耗尽次数、进死信队列，任务永远停在 pending）。
 *  - 消息到达时任务正在运行（还没超过 JOB_STALE_MS）：可能是重复消息，也可能是上一个消费者被中途杀掉后的重投。
 *    不能直接 ack（后者的消息就丢了，任务永远停在 running），延迟 JOB_STALE_MS 再看：那时要么已经结束，要么算卡住、重新认领。
 *  - 归还槽位之前，如果后面没活了就直接停掉容器（stopIfIdle），不等空闲超时。
 */

export interface JobRow {
	id: string;
	asset_id: string;
	kind: JobKind;
	status: "pending" | "running" | "done" | "failed";
	attempts: number;
	started_at: number | null;
}

/** 正在运行的任务：slot 是分到的 Processor 编号，deadline 之前必须结束（消费者 15 分钟墙钟上限）。 */
export interface RunningJob extends JobRow {
	slot: number;
	deadline: number;
}

export type JobHandler = (job: RunningJob, env: Env) => Promise<{ containerSeconds: number }>;

/** 各类任务的实现在 handlers 里注册（第 2 阶段起）。 */
export const handlers: Partial<Record<JobKind, JobHandler>> = {};

/**
 * 新建任务并入队。入队失败时撤掉刚插入的任务再抛错：不会留下一条没有队列消息、永远没人处理的 pending 任务。
 * 熔断时只写 D1 不入队，恢复时由 requeuePending 补发。
 */
export async function createJob(env: Env, assetId: string, kind: JobKind): Promise<string> {
	const { id, stmt } = jobInsert(env.DB, assetId, kind);
	await stmt.run();
	try {
		await enqueueJob(env, id);
	} catch (e) {
		await env.DB.prepare("DELETE FROM jobs WHERE id = ? AND status = 'pending' AND attempts = 0").bind(id).run();
		throw e;
	}
	return id;
}

/**
 * 一次给多个条目建同一种任务（原图压缩的批量操作）。插入按 batch 写，入队按 sendBatch 发；
 * 入队失败时撤掉还没入队的那些再抛错（和 createJob 一样，不留没有消息的 pending 任务）。熔断时只写 D1 不入队。
 * 只由用户点击触发，调用方限制条数（COMPRESS_BATCH_MAX）。返回建好的个数。
 */
export async function createJobs(env: Env, assetIds: string[], kind: JobKind): Promise<number> {
	const rows = assetIds.map((id) => jobInsert(env.DB, id, kind));
	for (let i = 0; i < rows.length; i += 50) await env.DB.batch(rows.slice(i, i + 50).map((r) => r.stmt));
	if (await guardStub(env).isTripped()) return rows.length;
	for (let i = 0; i < rows.length; i += 100) {
		try {
			await env.JOBS.sendBatch(rows.slice(i, i + 100).map((r) => ({ body: { jobId: r.id } satisfies JobMessage })));
		} catch (e) {
			const rest = rows.slice(i).map((r) => r.id);
			for (let j = 0; j < rest.length; j += 80) {
				const chunk = rest.slice(j, j + 80);
				await env.DB.prepare(`DELETE FROM jobs WHERE id IN (${chunk.map(() => "?").join(",")}) AND status = 'pending' AND attempts = 0`)
					.bind(...chunk)
					.run();
			}
			throw e;
		}
	}
	return rows.length;
}

/**
 * 插入 pending 任务的语句，放进和条目状态修改同一个 batch，保证两者一起落地。
 * when 是额外的 SQL 条件（参数接在后面），不满足就不插入；用 RETURNING 的结果判断插没插。插入之后调用 enqueueJob。
 */
export function jobInsert(
	db: D1Database,
	assetId: string,
	kind: JobKind,
	when: { sql: string; params: unknown[] } = { sql: "1", params: [] },
): { id: string; stmt: D1PreparedStatement } {
	const id = ulid();
	const stmt = db
		.prepare(
			`INSERT INTO jobs (id, asset_id, kind, status, attempts, updated_at)
			 SELECT ?, ?, ?, 'pending', 0, ? WHERE ${when.sql} RETURNING id`,
		)
		.bind(id, assetId, kind, Date.now(), ...when.params);
	return { id, stmt };
}

/** 把已经写进 D1 的任务投递到队列（熔断时跳过）。只给 createJob 和上传完成用。 */
export async function enqueueJob(env: Env, id: string): Promise<void> {
	if (await guardStub(env).isTripped()) return;
	await env.JOBS.send({ jobId: id } satisfies JobMessage);
}

/** recheck：任务正在运行，过 JOB_STALE_MS 再投递一次看看它是否卡住。 */
type Outcome = "ack" | "retry" | "busy" | "recheck";

/** startedAt：这次消费者调用开始的时间，用来算任务的 deadline。slotWaitMs 只在测试里改。 */
export async function handleJobMessage(
	msg: JobMessage,
	env: Env,
	{ startedAt = Date.now(), slotWaitMs = SLOT_WAIT_MS } = {},
): Promise<Outcome> {
	const guard = guardStub(env);
	const gate = await guard.gate();
	// 熔断：任务留在 pending，恢复时补发。设备端接管中：任务留在 pending 等设备拉取，租约失效后 Cron 补发。
	if (gate.tripped || gate.device) return "ack";

	const job = await env.DB.prepare(
		"SELECT id, asset_id, kind, status, attempts, started_at FROM jobs WHERE id = ?",
	)
		.bind(msg.jobId)
		.first<JobRow>();
	if (!job) return "ack";

	const now = Date.now();
	const stale = job.status === "running" && (job.started_at ?? 0) < now - JOB_STALE_MS;
	if (job.status === "running" && !stale) return "recheck";
	if (job.status !== "pending" && !stale) return "ack"; // 幂等：已经结束的任务直接跳过

	if (job.attempts >= MAX_JOB_ATTEMPTS) {
		await markFailed(env, job.id, "max attempts reached");
		return "ack";
	}

	const grant = await guard.acquireSlot(slotWaitMs);
	if (!grant.ok) return grant.reason === "busy" ? "busy" : "ack";
	try {
		return await runClaimed(job, env, grant.slot, startedAt + CONSUMER_BUDGET_MS);
	} finally {
		// 必须在释放槽位之前：释放之后这个 Processor 可能已经分给了别的任务。
		await stopIfIdle(env, grant.slot);
		await guard.releaseSlot(grant.lease);
	}
}

/**
 * 没有排队的任务、最近也没有新建上传时，后面大概率没活了，直接停掉这个槽位的容器，不等空闲超时。
 * 判断错了（刚好来了新任务）只是多一次冷启动。出错不影响任务结果，空闲超时兜底。
 */
async function stopIfIdle(env: Env, slot: number): Promise<void> {
	try {
		if (await moreWorkExpected(env)) return;
		await processorStub(env, slot).stopIfRunning();
	} catch (e) {
		console.warn(JSON.stringify({ event: "processor_stop_failed", slot, error: String(e).slice(0, 500) }));
	}
}

/** 还有排队的任务，或者最近 UPLOAD_ACTIVE_MS 内新建过上传。 */
export async function moreWorkExpected(env: Env, now = Date.now()): Promise<boolean> {
	const row = await env.DB.prepare(
		`SELECT EXISTS (SELECT 1 FROM jobs WHERE status = 'pending')
		     OR EXISTS (SELECT 1 FROM uploads WHERE created_at > ?) AS busy`,
	)
		.bind(now - UPLOAD_ACTIVE_MS)
		.first<{ busy: number }>();
	return Boolean(row?.busy);
}

async function runClaimed(job: JobRow, env: Env, slot: number, deadline: number): Promise<Outcome> {
	const guard = guardStub(env);
	const now = Date.now();

	// 原子地认领任务；并发的重复消息只有一个能成功。等槽位期间任务可能已被别人跑过，所以尝试次数以这里读到的为准。
	const claimed = await env.DB.prepare(
		`UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ?
		 WHERE id = ? AND ${CLAIMABLE_SQL}
		 RETURNING attempts`,
	)
		.bind(now, now, job.id, MAX_JOB_ATTEMPTS, now - JOB_STALE_MS)
		.first<{ attempts: number }>();
	if (!claimed) return "ack";
	const attempts = claimed.attempts;

	const reservation = await guard.reserveJob(job.asset_id, attempts > 1);
	if (!reservation.ok) {
		// 退回 pending，并把这次尝试还回去：不是任务本身的问题。
		await env.DB.prepare(
			"UPDATE jobs SET status = 'pending', attempts = attempts - 1, started_at = NULL, updated_at = ? WHERE id = ?",
		)
			.bind(Date.now(), job.id)
			.run();
		return "ack";
	}

	const handler = handlers[job.kind];
	if (!handler) {
		await markFailed(env, job.id, `no handler for ${job.kind}`);
		return "ack";
	}

	try {
		const { containerSeconds } = await handler({ ...job, attempts, slot, deadline }, env);
		await guard.recordContainer(containerSeconds);
		await settleJob(env, job.id, attempts, null);
		return "ack";
	} catch (e) {
		await guard.recordContainer((e as { containerSeconds?: number }).containerSeconds ?? 0);
		return (await settleJob(env, job.id, attempts, e)) === "retry" ? "retry" : "ack";
	}
}

/** 认领条件：pending，或者卡住（running 超过 JOB_STALE_MS）；次数没用完。参数：MAX_JOB_ATTEMPTS、now - JOB_STALE_MS。容器和设备端共用。 */
export const CLAIMABLE_SQL = "attempts < ? AND (status = 'pending' OR (status = 'running' AND started_at < ?))";

/**
 * 任务运行结束后的收尾，容器和设备端共用（error 为 null 表示成功）：成功记 done；
 * 失败时次数用完或者 permanent（重试也不会成功，比如文件校验失败）记 failed，
 * 否则退回 pending（容器路径由 msg.retry() 重投，设备端路径由设备再次认领）。
 */
export async function settleJob(env: Env, jobId: string, attempts: number, error: unknown): Promise<"done" | "retry" | "failed"> {
	if (error === null) {
		await env.DB.prepare("UPDATE jobs SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?")
			.bind(Date.now(), jobId)
			.run();
		return "done";
	}
	const message = String(error).slice(0, 1000);
	if (attempts >= MAX_JOB_ATTEMPTS || (error as { permanent?: boolean }).permanent) {
		await markFailed(env, jobId, message);
		return "failed";
	}
	await env.DB.prepare("UPDATE jobs SET status = 'pending', started_at = NULL, last_error = ?, updated_at = ? WHERE id = ?")
		.bind(message, Date.now(), jobId)
		.run();
	return "retry";
}

export async function markFailed(env: Env, jobId: string, error: string) {
	const now = Date.now();
	await env.DB.batch([
		env.DB.prepare("UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?").bind(
			error,
			now,
			jobId,
		),
		env.DB.prepare(
			`UPDATE assets SET status = 'failed', updated_at = ?
			 WHERE id = (SELECT asset_id FROM jobs WHERE id = ?) AND status IN ('pending','processing')`,
		).bind(now, jobId),
	]);
}

/**
 * 熔断恢复 / 手动补发：把卡死的 running 和 pending 任务重新入队，每次最多 RESUME_BATCH 个。
 * 卡死的排在最前面，其余按 updated_at 从旧到新；补发时把 updated_at 改成现在，再点一次就轮到下一批。
 * 重复补发是安全的（认领是原子的，多出来的消息直接 ack）。由用户在界面上点击触发；自动调用只有设备端交还云端之后的补发
 * （requeueAfterDevice：交还时一批，设备突然消失时由每小时 Cron 每次一批）。
 */
export async function requeuePending(env: Env): Promise<number> {
	const now = Date.now();
	const { results } = await env.DB.prepare(
		`UPDATE jobs SET updated_at = ? WHERE id IN (
			SELECT id FROM jobs WHERE status = 'pending' OR (status = 'running' AND started_at < ?)
			ORDER BY status = 'running' DESC, updated_at LIMIT ?
		 ) RETURNING id, status`,
	)
		.bind(now, now - JOB_STALE_MS, RESUME_BATCH)
		.all<{ id: string; status: string }>();
	// RETURNING 不保证顺序：卡住的先发
	results.sort((a, b) => Number(b.status === "running") - Number(a.status === "running"));
	for (let i = 0; i < results.length; i += 100) {
		await env.JOBS.sendBatch(results.slice(i, i + 100).map((r) => ({ body: { jobId: r.id } satisfies JobMessage })));
	}
	return results.length;
}

/**
 * 设备端接管期间消费者 ack 掉的消息：租约失效（设备关掉、断网）之后补发，任务回到容器。
 * 每次最多 RESUME_BATCH 个，还有剩下的就保留标志，下一小时的 Cron 继续；熔断时不补发（恢复时会补发）。返回补发的个数。
 */
export async function requeueAfterDevice(env: Env): Promise<number> {
	const guard = guardStub(env);
	if (!(await guard.deviceSkippedPending())) return 0;
	const requeued = await requeuePending(env);
	if (requeued < RESUME_BATCH) await guard.clearDeviceSkipped();
	return requeued;
}

/** 用户手动停止的任务记成 failed，last_error 是这个，之后可以照常重试。 */
export const CANCELLED_ERROR = "cancelled";

/**
 * 手动停止任务：把 pending（以及卡死的 running）任务标记为 failed（last_error = cancelled），
 * 条目还在 pending / processing 的跟着变成 failed，和用完尝试次数一样，之后可以在“处理失败”里重试。
 * 认领和停止都要求 status = 'pending'，并发时只有一个成功；正在运行的任务不动（它的结果会覆盖这里的修改）。
 * 熔断时也允许：停掉反复处理的条目之后再恢复。只由用户点击触发，每次最多 RETRY_FAILED_MAX 个。返回停止的个数。
 */
export async function cancelJobs(env: Env, jobIds: string[]): Promise<number> {
	const ids = [...new Set(jobIds)].slice(0, RETRY_FAILED_MAX);
	const now = Date.now();
	let cancelled = 0;
	for (let i = 0; i < ids.length; i += 80) {
		const chunk = ids.slice(i, i + 80);
		const marks = chunk.map(() => "?").join(",");
		const [jobs] = await env.DB.batch<{ id: string }>([
			env.DB.prepare(
				`UPDATE jobs SET status = 'failed', last_error = ?, started_at = NULL, updated_at = ?
				 WHERE id IN (${marks}) AND (status = 'pending' OR (status = 'running' AND started_at < ?)) RETURNING id`,
			).bind(CANCELLED_ERROR, now, ...chunk, now - JOB_STALE_MS),
			env.DB.prepare(
				`UPDATE assets SET status = 'failed', updated_at = ?
				 WHERE id IN (SELECT asset_id FROM jobs WHERE id IN (${marks}) AND status = 'failed' AND updated_at = ?)
				   AND status IN ('pending','processing')`,
			).bind(now, ...chunk, now),
		]);
		cancelled += jobs!.results.length;
	}
	return cancelled;
}

/** 每次手动重试最多这么多个失败任务（设置页的“全部重试”也只重试列出来的这些）。 */
export const RETRY_FAILED_MAX = 200;

/**
 * 手动重试失败的任务：清零次数，重新入队。只由用户点击触发，每次最多 RETRY_FAILED_MAX 个，
 * 只有确实处于 failed 的才会入队。返回入队的个数。
 */
export async function retryFailed(env: Env, jobIds: string[]): Promise<number> {
	const ids = [...new Set(jobIds)].slice(0, RETRY_FAILED_MAX);
	const now = Date.now();
	const retried: string[] = [];
	// D1 单条语句最多 100 个参数
	for (let i = 0; i < ids.length; i += 80) {
		const chunk = ids.slice(i, i + 80);
		const { results } = await env.DB.prepare(
			`UPDATE jobs SET status = 'pending', attempts = 0, last_error = NULL, updated_at = ?
			 WHERE status = 'failed' AND id IN (${chunk.map(() => "?").join(",")}) RETURNING id`,
		)
			.bind(now, ...chunk)
			.all<{ id: string }>();
		retried.push(...results.map((r) => r.id));
	}
	for (let i = 0; i < retried.length; i += 100) {
		await env.JOBS.sendBatch(retried.slice(i, i + 100).map((id) => ({ body: { jobId: id } satisfies JobMessage })));
	}
	return retried.length;
}
