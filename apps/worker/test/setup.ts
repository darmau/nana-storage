import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";

await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
