import { useSyncExternalStore } from "react";
import { t } from "../i18n";
import { connectionStore } from "../api";

/** 断网或登录过期时的提示。登录过期只能整页重新加载，让 Access 走一遍登录。 */
export function ConnectionBanner() {
	const state = useSyncExternalStore(connectionStore.subscribe, connectionStore.get);
	if (state === "ok") return null;
	return (
		<div role="status" className="flex items-center gap-3 border-b border-border bg-notice px-4 py-2 text-sm md:ml-[var(--sidebar-w)]">
			<span className="min-w-0 flex-1">{state === "offline" ? t.banners.offline : t.banners.lost}</span>
			{state === "lost" && (
				<button type="button" className="btn !h-8 shrink-0" onClick={() => location.reload()}>
					{t.banners.reload}
				</button>
			)}
		</div>
	);
}
