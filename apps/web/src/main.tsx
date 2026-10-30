import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "./api";
import { restoreQueryCache } from "./library/persist";
import { router } from "./router";
import "./styles.css";

// 成本规则：重试有上限、不做定时轮询、窗口切回时不自动重新请求。
const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			retry: (count, err) => count < 2 && !(err instanceof ApiError && err.status < 500),
			retryDelay: (n) => 1000 * 4 ** n,
			refetchOnWindowFocus: false,
			staleTime: 60_000,
			// 离开页面后半小时内回来直接显示内存里的数据；这些也是下次打开应用时恢复的来源（library/persist.ts）
			gcTime: 30 * 60_000,
		},
		mutations: { retry: false },
	},
});

// 先恢复上次的列表数据再渲染，首页 / 相册 / 文件夹打开时不用等请求（最多等 IndexedDB 0.5 秒）
await restoreQueryCache(queryClient);

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	</StrictMode>,
);
