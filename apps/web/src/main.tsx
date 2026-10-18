import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "./api";
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
		},
		mutations: { retry: false },
	},
});

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	</StrictMode>,
);
