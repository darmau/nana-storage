#!/usr/bin/env node
// 一次性初始化（pnpm run setup），在部署者自己的电脑上运行；可以重复运行，已有的东西会跳过。
//   1. 创建 D1 / R2 / KV / 队列 / Vectorize（用 wrangler login 的身份）
//   2. 执行 D1 迁移
//   3. 建 Zero Trust Access 应用（只放行一个邮箱，邮箱验证码登录），拿到 AUD（需要 API 令牌；没有就手动填）
//   4. 写入 Worker secret（不落盘）
//   5. 打印 Workers Builds 的设置
// 部署者的信息都不写进仓库文件，见 scripts/render-wrangler.mjs。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { normalizeDomain, renderConfig, writeDeployConfig } from "./render-wrangler.mjs";

const workerDir = fileURLToPath(new URL("../apps/worker/", import.meta.url));
const WORKER_NAME = "nana-storage";
const API = "https://api.cloudflare.com/client/v4";

const rl = createInterface({ input: process.stdin, output: process.stdout });
let muted = false;
const writeOut = rl._writeToOutput.bind(rl);
rl._writeToOutput = (s) => (muted ? undefined : writeOut(s));

const ask = (q, def = "") =>
	new Promise((r) => rl.question(def ? `${q} [${def}] ` : `${q} `, (a) => r(a.trim() || def)));
/** 输入不回显（令牌）。 */
const askSecret = (q) =>
	new Promise((r) => {
		process.stdout.write(`${q} `);
		muted = true;
		rl.question("", (a) => {
			muted = false;
			process.stdout.write("\n");
			r(a.trim());
		});
	});
const step = (s) => console.log(`\n== ${s}`);
const fail = (msg) => {
	console.error(`\n✘ ${msg}`);
	process.exit(1);
};

// 创建资源时在空目录里运行 wrangler，避免它把资源写回模板 wrangler.jsonc。
const scratch = mkdtempSync(join(tmpdir(), "nana-setup-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

function wrangler(args, { cwd = scratch, input, json = false } = {}) {
	const r = spawnSync("npx", ["wrangler", ...args], {
		cwd,
		input,
		encoding: "utf8",
		// 不要设 WRANGLER_LOG=error：--json 的输出也走普通日志级别，会被一起吞掉。
	});
	const out = `${r.stdout}${r.stderr}`;
	if (json && r.status === 0) return JSON.parse(r.stdout.slice(r.stdout.search(/[[{]/)));
	return { ok: r.status === 0, out };
}

/** 创建资源；已经存在算成功。 */
function ensure(label, args) {
	const { ok, out } = wrangler(args);
	if (ok) console.log(`  + ${label}`);
	else if (/already (exists|taken)|already been taken|already in use/i.test(out)) console.log(`  = ${label} (already exists)`);
	else fail(`Failed to create ${label}:\n${out}`);
}

async function cf(token, method, path, body) {
	const res = await fetch(`${API}${path}`, {
		method,
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	const json = await res.json().catch(() => ({}));
	if (!json.success) {
		const msg = json.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`;
		throw new Error(`${method} ${path} → ${msg}`);
	}
	return json.result;
}

async function setupAccess(token, accountId, domain, email) {
	const base = `/accounts/${accountId}/access`;
	let org;
	try {
		org = await cf(token, "GET", `${base}/organizations`);
	} catch (e) {
		fail(`Could not read the Zero Trust organization. Is Zero Trust enabled? Pick a plan (Free is fine) under Zero Trust in the dashboard. ${e.message}`);
	}
	const teamDomain = `https://${org.auth_domain}`;

	const idps = await cf(token, "GET", `${base}/identity_providers`);
	let otp = idps.find((p) => p.type === "onetimepin");
	if (!otp) otp = await cf(token, "POST", `${base}/identity_providers`, { name: "One-time PIN", type: "onetimepin", config: {} });

	const apps = await cf(token, "GET", `${base}/apps`);
	const existing = apps.find((a) => a.domain === domain || a.self_hosted_domains?.includes(domain));
	if (existing) {
		console.log(`  = Access application already exists: ${existing.name}`);
		console.log("    Check in the Zero Trust dashboard that its policy allows only your own email.");
		return { teamDomain, aud: existing.aud };
	}
	const policy = await cf(token, "POST", `${base}/policies`, {
		name: `${WORKER_NAME} owner`,
		decision: "allow",
		include: [{ email: { email } }],
		session_duration: "24h",
	});
	const app = await cf(token, "POST", `${base}/apps`, {
		name: WORKER_NAME,
		type: "self_hosted",
		domain,
		session_duration: "24h",
		allowed_idps: [otp.id],
		auto_redirect_to_identity: true,
		app_launcher_visible: false,
		policies: [{ id: policy.id, precedence: 1 }],
	});
	console.log(`  + Access application ${app.name} (allows only ${email}, one-time PIN login)`);
	return { teamDomain, aud: app.aud };
}

async function main() {
	console.log("nana-storage setup. Safe to re-run: existing resources are skipped.\n");

	const who = wrangler(["whoami", "--json"], { json: true });
	if (!who.loggedIn) fail("wrangler is not logged in. Run: cd apps/worker && npx wrangler login");
	let account = who.accounts[0];
	if (who.accounts.length > 1) {
		who.accounts.forEach((a, i) => console.log(`  ${i + 1}. ${a.name} (${a.id})`));
		const n = Number(await ask("Which account should it be deployed to?", "1"));
		account = who.accounts[n - 1] ?? fail("No such account");
	}
	process.env.CLOUDFLARE_ACCOUNT_ID = account.id;
	console.log(`Account: ${account.name}`);

	let domain;
	while (!domain) {
		const raw = await ask("Domain for the library (must be on Cloudflare in this account, e.g. photos.example.com):");
		domain = normalizeDomain(raw);
		if (!domain) console.log("  Enter a hostname only, without protocol or path.");
	}
	let email;
	while (!email) {
		const raw = await ask("The only email allowed to access the library:");
		email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw.toLowerCase() : null;
		if (!email) console.log("  That doesn't look like an email address.");
	}

	step("Creating resources");
	const d1 = new Map(wrangler(["d1", "list", "--json"], { json: true }).map((d) => [d.name, d.uuid]));
	if (d1.has("nana-db")) console.log("  = D1 nana-db (already exists)");
	else ensure("D1 nana-db", ["d1", "create", "nana-db"]);
	const kv = wrangler(["kv", "namespace", "list"], { json: true });
	if (kv.some((n) => n.title === "nana-kv")) console.log("  = KV nana-kv (already exists)");
	else ensure("KV nana-kv", ["kv", "namespace", "create", "nana-kv"]);
	ensure("R2 nana-photos", ["r2", "bucket", "create", "nana-photos"]);
	ensure("Queue nana-jobs", ["queues", "create", "nana-jobs"]);
	ensure("Queue nana-jobs-dlq", ["queues", "create", "nana-jobs-dlq"]);
	// 维度和度量创建后不能改。
	ensure("Vectorize nana-faces", ["vectorize", "create", "nana-faces", "--dimensions=512", "--metric=cosine"]);
	console.log("  Keep the R2 bucket at its defaults: no public access, no r2.dev subdomain, no custom domain.");

	step("D1 migrations");
	const { config, problems } = renderConfig(domain);
	if (problems.length) fail(problems.join("\n  "));
	writeDeployConfig(config);
	const migrate = spawnSync("npx", ["wrangler", "d1", "migrations", "apply", "nana-db", "--remote", "-c", "wrangler.deploy.json"], {
		cwd: workerDir,
		stdio: ["ignore", "inherit", "inherit"],
	});
	if (migrate.status !== 0) fail("D1 migrations failed");

	step("Zero Trust Access");
	console.log("Configuring Access automatically needs an API token (used for this run only, never stored) with:");
	console.log("  Account → Access: Apps and Policies → Edit");
	console.log("  Account → Access: Organizations, Identity Providers, and Groups → Edit");
	console.log("  Account → D1 → Edit (optional, to enable read replication)");
	console.log("Create one at https://dash.cloudflare.com/profile/api-tokens and delete it afterwards.");
	console.log("Press Enter to configure Access by hand instead.");
	const token = await askSecret("API token:");
	let teamDomain;
	let aud;
	if (token) {
		({ teamDomain, aud } = await setupAccess(token, account.id, domain, email));
		try {
			await cf(token, "PUT", `/accounts/${account.id}/d1/database/${config.d1_databases[0].database_id}`, {
				read_replication: { mode: "auto" },
			});
			console.log("  + D1 read replication enabled");
		} catch (e) {
			console.log(`  - Could not enable D1 read replication (optional, see docs/deploy.en.md): ${e.message}`);
		}
	} else {
		console.log(`\nBy hand: Zero Trust → Access → Applications → Add a self-hosted application for ${domain}, path empty.`);
		console.log(`Policy "Allow", Include → Emails → only ${email}. Login methods: One-time PIN only.`);
		console.log("Save it, then copy the Application Audience (AUD) tag.");
		teamDomain = await ask("Team domain (https://<team>.cloudflareaccess.com):");
		aud = await ask("Application AUD tag:");
		if (!teamDomain || !aud) fail("Team domain or AUD missing");
	}

	step("Writing Worker secrets");
	const secrets = { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: aud, OWNER_EMAIL: email };
	for (const [name, value] of Object.entries(secrets)) {
		// 非交互模式下，Worker 不存在时 wrangler 会先建一个空的 Worker（之后 Workers Builds 连接的就是它）。
		const { ok, out } = wrangler(["secret", "put", name, "-c", "wrangler.deploy.json"], { cwd: workerDir, input: value });
		if (!ok) fail(`Failed to write ${name}:\n${out}`);
		console.log(`  + ${name}`);
	}

	step("Last step: connect GitHub (Workers Builds)");
	console.log(`Cloudflare dashboard → Workers & Pages → ${WORKER_NAME} → Settings → Builds → connect your fork:`);
	console.log("  Production branch     main");
	console.log("  Root directory        apps/worker");
	console.log("  Build command         cd ../.. && pnpm install --frozen-lockfile && pnpm run ci");
	console.log("  Deploy command        cd ../.. && pnpm run deploy");
	console.log(`  Build variables       NANA_DOMAIN = ${domain}`);
	console.log("                        NANA_FACES = off   (optional: disables face recognition, see NOTICE)");
	console.log("  Non-production builds off");
	console.log("Then trigger a build (push, or click Retry in the dashboard). Later, Sync fork on GitHub updates the app.");
	console.log("Post-deploy checklist: docs/deploy.en.md.");
	rl.close();
}

main().catch((e) => fail(e.stack ?? String(e)));
