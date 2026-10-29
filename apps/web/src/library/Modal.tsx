import { useEffect, useRef } from "react";
import { IconClose } from "../ui/icons";
import { t } from "../i18n";

/** wide：桌面上更宽（需要预览图片的弹窗）。 */
export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		// 弹窗里还可以再开弹窗（比如在地图上选位置），Esc 只关最上面的那个
		const onKey = (e: KeyboardEvent) => {
			const dialogs = document.querySelectorAll('[aria-modal="true"]');
			if (e.key === "Escape" && dialogs[dialogs.length - 1] === ref.current) onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/45 backdrop-blur-[2px] fade-in sm:items-center" onClick={onClose}>
			<div
				ref={ref}
				role="dialog"
				aria-modal="true"
				aria-label={title}
				className={`max-h-[80dvh] w-full overflow-y-auto rounded-t-3xl bg-card p-5 pb-[max(1.25rem,var(--safe-bottom))] shadow-2xl sheet-in sm:rounded-3xl ${wide ? "sm:w-[40rem]" : "sm:w-[28rem]"} sm:pb-5`}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="mb-4 flex items-center justify-between">
					<h2 className="text-lg font-bold">{title}</h2>
					<button className="-mr-2 flex h-10 w-10 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-fg" onClick={onClose} aria-label={t.common.close}>
						<IconClose size={18} />
					</button>
				</div>
				{children}
			</div>
		</div>
	);
}
