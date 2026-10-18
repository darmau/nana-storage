import { defineConfig } from "vitest/config";

// 纯函数测试，跑在 Node 里（可以调用本机的 python3 / unzip 校验输出）。
export default defineConfig({ test: { include: ["test-node/**/*.test.ts"], environment: "node" } });
