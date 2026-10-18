import { Link } from "@tanstack/react-router";
import { t } from "../i18n";
import { useGuard } from "../guard";

export function GuardBanner() {
	const { data } = useGuard();
	if (!data?.tripped) return null;
	return (
		<div className="border-b border-danger/40 bg-danger/10 px-4 py-2 text-sm md:ml-[var(--sidebar-w)]">
			<strong className="text-danger">{t.banners.guardTripped}</strong>{" "}
			<span className="text-muted">{data.trippedReason}</span>{" "}
			<Link to="/settings/guard" className="text-accent underline">
				{t.banners.view}
			</Link>
		</div>
	);
}
