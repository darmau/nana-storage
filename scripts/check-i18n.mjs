#!/usr/bin/env node
// 前端文案检查：apps/web/src 里（i18n/ 和测试文件除外）的字符串、模板字符串、JSX 文本不能出现中文，
// 界面文案一律写进 src/i18n 的语言文件。注释不算：按语法树检查，不靠正则猜注释。
// 默认只列出还没迁移的地方；加 --strict 时有任何一处就失败（迁移完成后放进 CI）。
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const web = join(root, "apps/web");
const src = join(web, "src");
const strict = process.argv.includes("--strict");

// 用前端自己依赖的 vite 解析（oxc），不额外装解析器
const vite = await import(pathToFileURL(createRequire(join(web, "package.json")).resolve("vite")).href);

const CJK = /[　-〿㐀-鿿＀-￯]/;

function* files(dir) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (p !== join(src, "i18n")) yield* files(p);
		} else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) {
			yield p;
		}
	}
}

function literals(node, out) {
	if (!node || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		for (const n of node) literals(n, out);
		return out;
	}
	const text =
		node.type === "Literal" && typeof node.value === "string"
			? node.value
			: node.type === "JSXText"
				? node.value
				: node.type === "TemplateElement"
					? node.value.raw
					: null;
	if (text && CJK.test(text)) out.push({ start: node.start, text: text.trim() });
	for (const k in node) if (k !== "parent") literals(node[k], out);
	return out;
}

let total = 0;
const perFile = [];
for (const file of files(src)) {
	const code = readFileSync(file, "utf8");
	const hits = literals(vite.parseAst(code, { lang: file.endsWith(".tsx") ? "tsx" : "ts" }), []);
	if (!hits.length) continue;
	total += hits.length;
	const rel = relative(root, file);
	perFile.push([rel, hits.length]);
	if (strict) {
		for (const h of hits) {
			const line = code.slice(0, h.start).split("\n").length;
			console.error(`${rel}:${line}  ${h.text.slice(0, 60)}`);
		}
	}
}

if (!total) {
	console.log("i18n 检查通过：前端没有写死的中文文案");
} else if (strict) {
	console.error(`\n${total} 处中文文案没有放进 apps/web/src/i18n。`);
	process.exit(1);
} else {
	perFile.sort((a, b) => b[1] - a[1]);
	for (const [f, n] of perFile) console.log(`${String(n).padStart(4)}  ${f}`);
	console.log(`\n还有 ${total} 处中文文案在 ${perFile.length} 个文件里（--strict 列出每一处）。`);
}
