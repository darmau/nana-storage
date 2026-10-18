import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { defineConfig } from "vite";

/** 设置页“关于”里显示的版本：Workers Builds 提供提交号，本地构建时读 git。 */
function commit() {
	const sha = process.env.WORKERS_CI_COMMIT_SHA;
	if (sha) return sha.slice(0, 7);
	try {
		return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
	} catch {
		return "dev";
	}
}

// 开发时 /api 代理到 wrangler dev（8787）。.dev.vars 里把 APP_ORIGIN 设成 http://localhost:5173。
export default defineConfig({
	plugins: [react(), tailwindcss()],
	define: { __APP_BUILD__: JSON.stringify({ commit: commit(), builtAt: new Date().toISOString() }) },
	build: { outDir: "dist", sourcemap: false, assetsInlineLimit: 0 },
	server: { proxy: { "/api": { target: "http://localhost:8787" } } },
	worker: { format: "es" },
});
