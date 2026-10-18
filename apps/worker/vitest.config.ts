import { writeFileSync } from "node:fs";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { experimental_readRawConfig } from "wrangler";
import { defineConfig } from "vitest/config";

/**
 * 单元测试用一份从 wrangler.jsonc 生成的配置，去掉了队列消费者：
 * 否则 createJob 发出的消息会被真实的消费者在后台处理（还会去调用容器），测试结果取决于机器快慢。
 * 消费者的逻辑由测试直接调用 handleJobMessage 覆盖。miniflare 合并配置时只会叠加，没法用覆盖的方式去掉消费者。
 * 同理去掉 Vectorize 绑定。生成的文件放在同一目录，配置里的相对路径（入口、静态资源、迁移、Dockerfile）保持不变。
 */
function testWranglerConfig(): string {
	const { rawConfig } = experimental_readRawConfig({ config: path.join(import.meta.dirname, "wrangler.jsonc") });
	// Vectorize 没有本地模拟，测试里用内存假实现（test/similar.test.ts）。
	const { vectorize: _vectorize, ...rest } = rawConfig;
	const config = { ...rest, queues: { ...rawConfig.queues, consumers: [] } };
	const out = path.join(import.meta.dirname, "wrangler.test.generated.json");
	writeFileSync(out, JSON.stringify(config, null, "\t"));
	return out;
}

export default defineConfig(async () => {
	const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: testWranglerConfig() },
				miniflare: {
					bindings: {
						TEST_MIGRATIONS: migrations,
						ACCESS_TEAM_DOMAIN: "https://test-team.cloudflareaccess.com",
						ACCESS_AUD: "dev-aud",
						OWNER_EMAIL: "dev@localhost",
						APP_ORIGIN: "http://example.com",
					},
				},
			}),
		],
		test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] },
	};
});
