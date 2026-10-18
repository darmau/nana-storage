#!/usr/bin/env node
// 部署前从模板 apps/worker/wrangler.jsonc 生成 apps/worker/wrangler.deploy.json（不进仓库）：
//   - 域名：环境变量 NANA_DOMAIN（Workers Builds 的构建变量），写进 routes（自定义域名）和 vars.APP_ORIGIN；
//   - D1 / KV 的 ID：按名字向 Cloudflare 查（用 wrangler 当前的凭据，Workers Builds 里就是构建令牌）。
//   - 可选的 NANA_FACES=off：关掉人脸识别（容器镜像不下载人脸模型，见 apps/processor/Dockerfile），
//     写进容器镜像的 build_vars（DO 管理的容器不支持 image_vars）。
// 部署者的信息都不进仓库，所以 fork 和上游完全一致，同步上游不会冲突。
// 只查不建：缺资源时报错并提示运行 pnpm run setup，不在 CI 里悄悄创建资源。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workerDir = fileURLToPath(new URL("../apps/worker/", import.meta.url));
const templatePath = `${workerDir}wrangler.jsonc`;
export const deployConfigPath = `${workerDir}wrangler.deploy.json`;

/** 和模板里的名字一致。 */
const KV_TITLE = "nana-kv";

/** 去掉 JSONC 的注释和尾逗号（跳过字符串里的内容）。 */
export function parseJsonc(text) {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j;
		} else if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else if (c === "/" && text[i + 1] === "*") {
			i = text.indexOf("*/", i + 2) + 1;
		} else out += c;
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** 只接受主机名（不带协议、路径、端口）。 */
export function normalizeDomain(raw) {
	const d = String(raw ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
	if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) return null;
	return d;
}

function wranglerJson(args) {
	const out = execFileSync("npx", ["wrangler", ...args], {
		cwd: workerDir,
		encoding: "utf8",
		// 不要设 WRANGLER_LOG=error：--json 的输出也走普通日志级别，会被一起吞掉。
		stdio: ["ignore", "pipe", "inherit"],
	});
	if (!out.trim()) throw new Error(`wrangler ${args.join(" ")} printed nothing`);
	// 有的版本会在 JSON 前面打印横幅，从第一个 [ 或 { 开始解析。
	const start = out.search(/[[{]/);
	return JSON.parse(out.slice(start));
}

/**
 * 生成部署配置。lookup 可以替换（测试用）；默认用 wrangler 查 D1 和 KV。
 * 返回 { config, problems }，problems 不为空时不应部署。
 */
export function renderConfig(domainRaw, lookup = defaultLookup, faces = process.env.NANA_FACES) {
	const template = parseJsonc(readFileSync(templatePath, "utf8"));
	const problems = [];
	const domain = normalizeDomain(domainRaw);
	if (!domain) {
		problems.push(
			domainRaw
				? `NANA_DOMAIN is not a valid hostname: ${domainRaw} (hostname only, e.g. photos.example.com)`
				: "NANA_DOMAIN is not set (add it under Workers Builds → Build variables, e.g. photos.example.com)",
		);
	}
	const config = structuredClone(template);
	if (domain) {
		config.routes = [{ pattern: domain, custom_domain: true }];
		config.vars = { ...config.vars, APP_ORIGIN: `https://${domain}` };
	}
	delete config.$schema;
	const facesMode = String(faces ?? "on").trim().toLowerCase() || "on";
	if (facesMode !== "on" && facesMode !== "off") problems.push(`NANA_FACES must be on or off: ${faces}`);
	else
		for (const c of config.containers ?? [])
			for (const img of Object.values(c.images ?? {}))
				if (img.dockerfile) img.build_vars = { ...img.build_vars, NANA_FACES: facesMode };

	let found;
	try {
		found = lookup();
	} catch (e) {
		problems.push(`Failed to look up Cloudflare resources: ${e.message}`);
		return { config, problems };
	}
	for (const db of config.d1_databases ?? []) {
		const id = found.d1.get(db.database_name);
		if (id) db.database_id = id;
		else problems.push(`D1 database not found: ${db.database_name}`);
	}
	for (const kv of config.kv_namespaces ?? []) {
		const id = found.kv.get(KV_TITLE);
		if (id) kv.id = id;
		else problems.push(`KV namespace not found: ${KV_TITLE}`);
	}
	if (found.vectorize) {
		for (const v of config.vectorize ?? []) {
			if (!found.vectorize.has(v.index_name)) problems.push(`Vectorize index not found: ${v.index_name}`);
		}
	}
	return { config, problems };
}

function defaultLookup() {
	const d1 = new Map(wranglerJson(["d1", "list", "--json"]).map((d) => [d.name, d.uuid]));
	const kv = new Map(wranglerJson(["kv", "namespace", "list"]).map((n) => [n.title, n.id]));
	// Vectorize 只是提前给出清楚的报错；构建令牌没有读取权限时跳过，交给 wrangler deploy 自己报错。
	let vectorize = null;
	try {
		vectorize = new Set(wranglerJson(["vectorize", "list", "--json"]).map((v) => v.name));
	} catch {
		console.warn("(Could not list Vectorize indexes; skipping that check)");
	}
	return { d1, kv, vectorize };
}

export function writeDeployConfig(config) {
	writeFileSync(deployConfigPath, `${JSON.stringify(config, null, "\t")}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { config, problems } = renderConfig(process.env.NANA_DOMAIN);
	if (problems.length) {
		console.error("Cannot generate the deploy config, refusing to deploy:\n  " + problems.join("\n  "));
		console.error("If resources are missing, run pnpm run setup on your own machine (safe to re-run). See docs/deploy.en.md.");
		process.exit(1);
	}
	writeDeployConfig(config);
	console.log(`Deploy config generated: ${config.routes[0].pattern}, face recognition ${config.containers[0].images.base.build_vars.NANA_FACES}`);
}
