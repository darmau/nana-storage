#!/usr/bin/env node
// 静态检查成本规则（见 CLAUDE.md）。CI 和提交前都要跑：pnpm check:cost-rules
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const SRC = ["apps/worker/src", "apps/web/src", "apps/processor", "apps/device"];

const rules = [
	{ id: "no-alarm", re: /\bsetAlarm\s*\(|\balarm\s*\(\s*\w*\s*\)\s*\{/, msg: "不允许使用 Durable Object alarm" },
	{ id: "no-container-class", re: /@cloudflare\/containers/, msg: "不用 Container 类（内部有自我续期的 alarm 循环），用 ctx.container" },
	{ id: "no-keepalive", re: /\bkeepAlive\s*[:=]\s*true/, msg: "不允许 keepAlive" },
	{ id: "no-internet", re: /enableInternet\s*:\s*true/, msg: "容器不允许访问外网" },
	{ id: "no-refetch-interval", re: /refetchInterval\s*:/, msg: "前端不允许 refetchInterval 轮询，用有上限的轮询工具" },
	{ id: "no-self-fetch", re: /fetch\(\s*[`'"]https?:\/\/photos\./, msg: "Worker 不允许请求自己的域名" },
	{ id: "processor-pool", re: /PROCESSOR\.(idFromName|newUniqueId|idFromString|get)\(/, msg: "只能通过 processorStub() 获取 Processor", allow: ["apps/worker/src/processor.ts"] },
	{ id: "no-queue-send-in-consumer", re: /JOBS\.send(Batch)?\(/, msg: "只有 createJob / requeuePending / retryFailed 可以入队", allow: ["apps/worker/src/jobs.ts"] },
];

const files = [];
const walk = (dir) => {
	let entries;
	try { entries = readdirSync(dir); } catch { return; }
	for (const e of entries) {
		if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
		const p = join(dir, e);
		if (statSync(p).isDirectory()) walk(p);
		else if (/\.(m?[jt]sx?)$/.test(e)) files.push(p);
	}
};
SRC.forEach((d) => walk(join(root, d)));

let failed = 0;
for (const f of files) {
	const rel = relative(root, f);
	const lines = readFileSync(f, "utf8").split("\n");
	lines.forEach((line, i) => {
		if (/^\s*(\/\/|\*)/.test(line)) return; // 注释里提到不算
		for (const r of rules) {
			if (r.allow?.includes(rel)) continue;
			if (r.re.test(line)) {
				console.error(`${rel}:${i + 1}  [${r.id}] ${r.msg}`);
				failed++;
			}
		}
	});
}

const wrangler = readFileSync(join(root, "apps/worker/wrangler.jsonc"), "utf8");
const cfgChecks = [
	[/"workers_dev":\s*false/, "wrangler.jsonc 必须 workers_dev: false"],
	[/"preview_urls":\s*false/, "wrangler.jsonc 必须 preview_urls: false"],
	// 重投不启动容器（容器次数由 D1 的 MAX_JOB_ATTEMPTS 限制），次数太少反而会让积压的消息进死信队列，见 wrangler.jsonc
	[/"max_retries":\s*(?:\d{1,2}|100)\b/, "队列 max_retries 必须 ≤ 100"],
	[/"dead_letter_queue"/, "队列必须配置死信队列"],
	[/"run_worker_first":\s*true/, "静态资源必须先经过 Worker 鉴权"],
];
for (const [re, msg] of cfgChecks) if (!re.test(wrangler)) { console.error(msg); failed++; }
if (/event_notification|r2.*notification/i.test(wrangler)) { console.error("不允许配置 R2 事件通知"); failed++; }

// 容器数：硬上限不超过 32，队列并发和它一致（多出来的消费者只会在 UsageGuard 里排队）。
const limitsSrc = readFileSync(join(root, "packages/shared/src/limits.ts"), "utf8");
const pool = Number(limitsSrc.match(/export const PROCESSOR_POOL_SIZE = (\d+);/)?.[1]);
const defaultProcessors = Number(limitsSrc.match(/export const DEFAULT_PROCESSORS = (\d+);/)?.[1]);
const concurrency = Number(wrangler.match(/"max_concurrency":\s*(\d+)/)?.[1]);
if (!(pool >= 1 && pool <= 32)) { console.error(`PROCESSOR_POOL_SIZE 必须在 1–32 之间（现在是 ${pool}）`); failed++; }
if (!(defaultProcessors >= 1 && defaultProcessors <= 4)) { console.error(`DEFAULT_PROCESSORS 必须 ≤ 4（现在是 ${defaultProcessors}）`); failed++; }
if (concurrency !== pool) { console.error(`队列 max_concurrency（${concurrency}）必须等于 PROCESSOR_POOL_SIZE（${pool}）`); failed++; }

if (failed) { console.error(`\n${failed} 处违反成本规则`); process.exit(1); }
console.log(`成本规则检查通过（${files.length} 个文件）`);
