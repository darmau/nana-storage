import { DurableObject } from "cloudflare:workers";
import {
	containerCost,
	DEFAULT_MONTHLY_BUDGET_USD,
	DEFAULT_PROCESSORS,
	DEVICE_LEASE_MS,
	MAX_MONTHLY_BUDGET_USD,
	MAX_PROCESSORS_OVERRIDE_MS,
	MAX_PROCESS_PER_ASSET_PER_HOUR,
	MAX_RETRIES_PER_ASSET_PER_HOUR,
	PROCESSOR_POOL_SIZE,
	SLOT_LEASE_MS,
	SLOT_WAIT_MS,
	type DeviceLease,
	type GuardMetric,
	type GuardStatus,
	type UsageDay,
} from "@nana/shared";

/**
 * 成本防护的单例 DO：按 UTC 日期记账，只在可能失控时熔断：
 *  - 本月（UTC 自然月）容器的估算超额费用达到月度上限（默认 DEFAULT_MONTHLY_BUDGET_USD，设置页可改）；
 *  - 同一个条目一小时内被处理太多次（循环）。
 * 每天的容器时长、任务数、上传量只记账，不限制。
 *
 * 规则（见 CLAUDE.md）：本类不使用 alarm，也不调用任何其他 DO 或外部服务。
 * 它只在被调用时运行，旧数据在每次写入时顺手清理（每次最多删一小批）。
 *
 * 容器槽位：同时最多 processors() 个任务在用容器，每个任务独占一个 Processor（proc-N）。
 * 拿不到槽位的调用在内存里排队等待（最多 SLOT_WAIT_MS），有槽位释放时直接唤醒，不轮询。
 * 租约存在 SQLite 里，持有者异常退出时 SLOT_LEASE_MS 后自动收回。等待用的 setTimeout
 * 只在有调用挂起时存在，不会让 DO 自己醒来。
 *
 * 设备端处理（src/device.ts）：设备的租约也记在这里（state 表的 device_*），每次认领续期 DEVICE_LEASE_MS，
 * 过期即失效，不需要任何定时器。租约有效时 gate() 告诉消费者把消息 ack 掉，并记下 device_skipped，
 * 之后由 Cron 补发（见 jobs.ts 的 requeueAfterDevice）。
 */

export const GUARD_NAME = "global";
const LIMITS_OVERRIDE_KEY = "guard:limits-override";

/** KV 里的临时容器数。旧版本还可能带着已经废弃的每日上限字段，读的时候只看 processors。 */
interface LimitsOverride {
	limits?: { processors?: number };
	expiresAt: number;
}

/** 到期后在 KV 里多留一会儿再自动删除（读取时按 expiresAt 判断，这只是清理）。 */
const OVERRIDE_KV_GRACE_MS = 3600_000;

export type SlotGrant = { ok: true; slot: number; lease: string } | { ok: false; reason: "tripped" | "busy" };

interface Waiter {
	resolve: (grant: SlotGrant) => void;
	timer: ReturnType<typeof setTimeout>;
}

const clampProcessors = (n: number) => Math.min(PROCESSOR_POOL_SIZE, Math.max(1, Math.floor(n)));

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** 每日用量保留这么多天：够“使用统计”页显示本月和上个月。每天只有 3 行，数据量可以忽略。 */
const USAGE_RETENTION_DAYS = 62;

export class UsageGuard extends DurableObject<Env> {
	private sql: SqlStorage;
	private waiters: Waiter[] = [];
	private wakeTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL,
				PRIMARY KEY (day, metric));
			CREATE TABLE IF NOT EXISTS asset_runs (asset_id TEXT NOT NULL, ts INTEGER NOT NULL);
			CREATE INDEX IF NOT EXISTS asset_runs_idx ON asset_runs(asset_id, ts);
			CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
			CREATE TABLE IF NOT EXISTS slots (slot INTEGER PRIMARY KEY, lease TEXT NOT NULL, expires_at INTEGER NOT NULL);
		`);
		// retry：这次运行是不是任务的自动重试（第 2 次及以后的尝试）。旧表没有这一列。
		const cols = this.sql.exec<{ name: string }>("PRAGMA table_info(asset_runs)").toArray();
		if (!cols.some((c) => c.name === "retry")) this.sql.exec("ALTER TABLE asset_runs ADD COLUMN retry INTEGER NOT NULL DEFAULT 0");
	}

	private get(key: string): string | null {
		const row = this.sql.exec<{ value: string }>("SELECT value FROM state WHERE key = ?", key).toArray()[0];
		return row?.value ?? null;
	}

	private set(key: string, value: string | null) {
		if (value === null) this.sql.exec("DELETE FROM state WHERE key = ?", key);
		else this.sql.exec("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)", key, value);
	}

	private usage(day: string): Record<GuardMetric, number> {
		const out: Record<GuardMetric, number> = { containerSeconds: 0, jobs: 0, uploadBytes: 0 };
		for (const r of this.sql.exec<{ metric: GuardMetric; value: number }>(
			"SELECT metric, value FROM usage WHERE day = ?",
			day,
		)) {
			out[r.metric] = r.value;
		}
		return out;
	}

	private add(day: string, metric: GuardMetric, amount: number) {
		this.sql.exec(
			`INSERT INTO usage (day, metric, value) VALUES (?, ?, ?)
			 ON CONFLICT(day, metric) DO UPDATE SET value = value + excluded.value`,
			day,
			metric,
			amount,
		);
	}

	private override(): Promise<LimitsOverride | null> {
		return this.env.KV.get<LimitsOverride>(LIMITS_OVERRIDE_KEY, "json").catch(() => null);
	}

	private async processors(): Promise<number> {
		const override = await this.override();
		const raised = override?.limits?.processors;
		if (!override || override.expiresAt < Date.now() || raised === undefined) return DEFAULT_PROCESSORS;
		return clampProcessors(raised);
	}

	/** 本月（UTC 自然月）到目前为止的用量。 */
	private monthUsage(now = Date.now()): Record<GuardMetric, number> {
		const out: Record<GuardMetric, number> = { containerSeconds: 0, jobs: 0, uploadBytes: 0 };
		for (const r of this.sql.exec<{ metric: GuardMetric; value: number }>(
			"SELECT metric, SUM(value) AS value FROM usage WHERE day >= ? GROUP BY metric",
			`${today(now).slice(0, 7)}-01`,
		)) {
			out[r.metric] = r.value;
		}
		return out;
	}

	private budget(): number {
		const v = Number(this.get("budget_usd"));
		return v > 0 ? v : DEFAULT_MONTHLY_BUDGET_USD;
	}

	/** 达到月度上限就熔断，返回是否已达到。 */
	private checkBudget(now = Date.now()): boolean {
		const budget = this.budget();
		if (containerCost(this.monthUsage(now).containerSeconds) < budget) return false;
		this.tripInternal(`monthly container budget reached ($${budget})`);
		return true;
	}

	private cleanup(now: number) {
		const cutoffDay = today(now - USAGE_RETENTION_DAYS * 24 * 3600 * 1000);
		this.sql.exec("DELETE FROM usage WHERE day < ?", cutoffDay);
		this.sql.exec(
			"DELETE FROM asset_runs WHERE rowid IN (SELECT rowid FROM asset_runs WHERE ts < ? LIMIT 500)",
			now - 3600_000,
		);
	}

	/** assetId：因为同一条目反复处理而熔断时记下它，设置页据此列出它的任务。 */
	private tripInternal(reason: string, assetId: string | null = null) {
		if (this.get("tripped") === "1") return;
		this.set("tripped", "1");
		this.set("tripped_reason", reason);
		this.set("tripped_at", String(Date.now()));
		this.set("tripped_asset", assetId);
		console.warn(JSON.stringify({ event: "guard_tripped", reason }));
		for (const w of this.waiters.splice(0)) {
			clearTimeout(w.timer);
			w.resolve({ ok: false, reason: "tripped" });
		}
	}

	// ---- 容器槽位

	private busySlots(now: number): Set<number> {
		this.sql.exec("DELETE FROM slots WHERE expires_at < ?", now);
		return new Set(this.sql.exec<{ slot: number }>("SELECT slot FROM slots").toArray().map((r) => r.slot));
	}

	/** 同步完成“找空槽 + 写租约”，中间没有 await，不会把同一个槽给两个人。 */
	private grant(processors: number): SlotGrant | null {
		const now = Date.now();
		const busy = this.busySlots(now);
		for (let slot = 0; slot < processors; slot++) {
			if (busy.has(slot)) continue;
			const lease = crypto.randomUUID();
			this.sql.exec("INSERT INTO slots (slot, lease, expires_at) VALUES (?, ?, ?)", slot, lease, now + SLOT_LEASE_MS);
			return { ok: true, slot, lease };
		}
		return null;
	}

	/** 按先来后到把空出来的槽位交给等待者。 */
	private async pump() {
		if (!this.waiters.length) return;
		const processors = await this.processors();
		if (this.get("tripped") === "1") return;
		while (this.waiters.length) {
			const grant = this.grant(processors);
			if (!grant) break;
			const w = this.waiters.shift()!;
			clearTimeout(w.timer);
			w.resolve(grant);
		}
		this.scheduleWake();
	}

	/** 还有人在等时，在最早的租约到期时再看一次（收回异常退出者的槽位）。 */
	private scheduleWake() {
		if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
		this.wakeTimer = undefined;
		if (!this.waiters.length) return;
		const next = this.sql.exec<{ t: number | null }>("SELECT MIN(expires_at) AS t FROM slots").one().t;
		if (next === null) return;
		this.wakeTimer = setTimeout(() => void this.pump(), Math.max(1000, next - Date.now() + 100));
	}

	/**
	 * 处理任务之前先拿一个容器槽位，返回的 slot 就是要用的 Processor 编号。
	 * 用完必须 releaseSlot()。没有空位时最多等 waitMs，超时返回 busy。
	 */
	async acquireSlot(waitMs: number): Promise<SlotGrant> {
		if (this.get("tripped") === "1") return { ok: false, reason: "tripped" };
		const processors = await this.processors();
		// await 期间可能已经熔断：那时 tripInternal() 唤醒的等待者里还没有这一个，不再检查就会白等到超时
		if (this.get("tripped") === "1") return { ok: false, reason: "tripped" };
		if (!this.waiters.length) {
			const grant = this.grant(processors);
			if (grant) return grant;
		}
		const wait = Math.min(Math.max(waitMs, 0), SLOT_WAIT_MS);
		return new Promise<SlotGrant>((resolve) => {
			const waiter: Waiter = {
				resolve,
				timer: setTimeout(() => {
					this.waiters = this.waiters.filter((w) => w !== waiter);
					this.scheduleWake();
					resolve({ ok: false, reason: "busy" });
				}, wait),
			};
			this.waiters.push(waiter);
			this.scheduleWake();
		});
	}

	async releaseSlot(lease: string) {
		this.sql.exec("DELETE FROM slots WHERE lease = ?", lease);
		await this.pump();
	}

	async status(): Promise<GuardStatus> {
		const now = Date.now();
		const day = today(now);
		const override = await this.override();
		const month = this.monthUsage(now);
		return {
			day,
			tripped: this.get("tripped") === "1",
			trippedReason: this.get("tripped_reason"),
			trippedAt: Number(this.get("tripped_at")) || null,
			// 加 tripped_asset 之前的熔断只有原因文字
			trippedAssetId: this.get("tripped_asset") ?? /^asset (\S+) (?:processed|retried) /.exec(this.get("tripped_reason") ?? "")?.[1] ?? null,
			usage: this.usage(day),
			month,
			monthCostUsd: containerCost(month.containerSeconds),
			budgetUsd: this.budget(),
			processors: await this.processors(),
			busySlots: this.busySlots(Date.now()).size,
			overrideExpiresAt: override && override.expiresAt > Date.now() ? override.expiresAt : null,
			device: this.deviceLease(now),
		};
	}

	/** 使用统计页用：从 sinceDay（含）开始每天的用量，按日期升序。没有记录的日子不返回。 */
	async history(sinceDay: string): Promise<UsageDay[]> {
		const days = new Map<string, UsageDay>();
		for (const r of this.sql.exec<{ day: string; metric: GuardMetric; value: number }>(
			"SELECT day, metric, value FROM usage WHERE day >= ? ORDER BY day",
			sinceDay,
		)) {
			let d = days.get(r.day);
			if (!d) days.set(r.day, (d = { day: r.day, containerSeconds: 0, jobs: 0, uploadBytes: 0 }));
			d[r.metric] = r.value;
		}
		return [...days.values()];
	}

	async isTripped(): Promise<boolean> {
		return this.get("tripped") === "1";
	}

	// ---- 设备端处理

	private deviceLease(now = Date.now()): DeviceLease | null {
		const until = Number(this.get("device_until"));
		return until > now ? { name: this.get("device_name") ?? "", until } : null;
	}

	/**
	 * 队列消费者处理每条消息之前调用（代替 isTripped，仍然只有一次 DO 调用）。
	 * 设备租约有效时返回 device: true，消费者直接 ack，并记下有消息被跳过，租约失效后由 Cron 补发。
	 */
	async gate(): Promise<{ tripped: boolean; device: boolean }> {
		const tripped = this.get("tripped") === "1";
		const device = !tripped && this.deviceLease() !== null;
		if (device) this.set("device_skipped", "1");
		return { tripped, device };
	}

	/** 设备开始或继续接管任务（attach 和每次认领都调用）。熔断时拒绝。 */
	async renewDevice(name: string): Promise<{ ok: true; until: number } | { ok: false; reason: "tripped" }> {
		if (this.get("tripped") === "1") return { ok: false, reason: "tripped" };
		const until = Date.now() + DEVICE_LEASE_MS;
		this.set("device_until", String(until));
		this.set("device_name", name.slice(0, 64));
		return { ok: true, until };
	}

	/** 当前的设备租约（后台处理页显示），没有或已过期为 null。 */
	async device(): Promise<DeviceLease | null> {
		return this.deviceLease();
	}

	/** 设备交还云端：租约立即失效。 */
	async detachDevice() {
		this.set("device_until", null);
	}

	/**
	 * Cron 用：租约已经失效、并且租约期间有消息被消费者跳过时返回 true（调用方据此补发）。
	 * 补发完以后调用 clearDeviceSkipped()；还有剩下的就留着标志，下一小时继续。
	 */
	async deviceSkippedPending(): Promise<boolean> {
		return this.get("device_skipped") === "1" && this.deviceLease() === null && this.get("tripped") !== "1";
	}

	async clearDeviceSkipped() {
		if (this.deviceLease() === null) this.set("device_skipped", null);
	}

	/**
	 * 处理一个任务之前调用。返回 ok:false 时调用方不能启动容器。
	 * 会预先记 1 个任务；容器时长在 recordContainer() 里按实际值记。
	 * retry：这是任务的自动重试（第 2 次及以后的尝试）。自动重试和全部运行分别有每小时上限（见 limits.ts）。
	 */
	async reserveJob(assetId: string, retry = false): Promise<{ ok: true } | { ok: false; reason: string }> {
		const now = Date.now();
		if (this.get("tripped") === "1") return { ok: false, reason: "tripped" };

		const day = today(now);
		if (this.checkBudget(now)) return { ok: false, reason: "budget" };

		const { runs, retries } = this.sql
			.exec<{ runs: number; retries: number }>(
				"SELECT COUNT(*) AS runs, COALESCE(SUM(retry), 0) AS retries FROM asset_runs WHERE asset_id = ? AND ts > ?",
				assetId,
				now - 3600_000,
			)
			.one();
		if (runs >= MAX_PROCESS_PER_ASSET_PER_HOUR) {
			this.tripInternal(`asset ${assetId} processed ${runs + 1} times within an hour (possible loop)`, assetId);
			return { ok: false, reason: "loop" };
		}
		if (retry && retries >= MAX_RETRIES_PER_ASSET_PER_HOUR) {
			this.tripInternal(`asset ${assetId} retried ${retries + 1} times within an hour (possible loop)`, assetId);
			return { ok: false, reason: "loop" };
		}

		this.sql.exec("INSERT INTO asset_runs (asset_id, ts, retry) VALUES (?, ?, ?)", assetId, now, retry ? 1 : 0);
		this.add(day, "jobs", 1);
		this.cleanup(now);
		return { ok: true };
	}

	async recordContainer(seconds: number) {
		if (!(seconds > 0)) return;
		const now = Date.now();
		this.add(today(now), "containerSeconds", seconds);
		this.checkBudget(now);
	}

	/** 上传前调用：熔断时拒绝，否则记下上传量（只记账，不限制）。 */
	async reserveUpload(bytes: number): Promise<boolean> {
		if (this.get("tripped") === "1") return false;
		this.add(today(), "uploadBytes", bytes);
		return true;
	}

	async trip(reason: string) {
		this.tripInternal(reason);
	}

	/** 本月的估算费用是否已经达到上限：这时恢复熔断没有意义，下一个任务会马上再次熔断。 */
	async overBudget(): Promise<boolean> {
		return containerCost(this.monthUsage().containerSeconds) >= this.budget();
	}

	/** 修改月度上限（不会过期）。调高不会自动解除熔断，仍要手动恢复。 */
	async setBudget(usd: number) {
		if (!Number.isFinite(usd) || usd <= 0) return;
		this.set("budget_usd", String(Math.min(usd, MAX_MONTHLY_BUDGET_USD)));
	}

	async reset() {
		this.set("tripped", null);
		this.set("tripped_reason", null);
		this.set("tripped_at", null);
		this.set("tripped_asset", null);
		this.sql.exec("DELETE FROM asset_runs");
	}

	/** 批量导入时临时调高同时运行的容器数。最长 7 天，到期自动回落。 */
	async setProcessorsOverride(processors: number, durationMs: number) {
		if (!Number.isFinite(processors)) return;
		const ms = Math.min(Math.max(durationMs, 0), MAX_PROCESSORS_OVERRIDE_MS);
		await this.env.KV.put(
			LIMITS_OVERRIDE_KEY,
			JSON.stringify({ limits: { processors: clampProcessors(processors) }, expiresAt: Date.now() + ms } satisfies LimitsOverride),
			{ expirationTtl: Math.ceil((ms + OVERRIDE_KV_GRACE_MS) / 1000) },
		);
		// 容器数调高后，正在等的任务马上就能拿到新槽位。
		await this.pump();
	}

	/** 提前结束临时容器数，立即回到默认值。 */
	async clearProcessorsOverride() {
		await this.env.KV.delete(LIMITS_OVERRIDE_KEY);
	}
}

export const guardStub = (env: Env) => env.USAGE_GUARD.get(env.USAGE_GUARD.idFromName(GUARD_NAME));
