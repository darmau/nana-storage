import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../i18n";

interface Options {
	title: string;
	message?: string;
	/** 确认按钮的文字，默认“确定” */
	confirmLabel?: string;
	/** 确认按钮用危险色 */
	danger?: boolean;
}

interface PromptOptions extends Omit<Options, "danger"> {
	defaultValue?: string;
	placeholder?: string;
}

interface DialogProps extends Options {
	/** 有就显示一个输入框（promptDialog） */
	input?: { defaultValue: string; placeholder?: string };
	/** 只有一个按钮（alertDialog） */
	single?: boolean;
	onDone: (ok: boolean, value: string) => void;
}

const EXIT_MS = 140;

function open(props: Omit<DialogProps, "onDone">, onDone: DialogProps["onDone"]) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const done = (ok: boolean, value: string) => {
		onDone(ok, value);
		setTimeout(() => {
			root.unmount();
			host.remove();
		}, EXIT_MS);
	};
	root.render(<ConfirmDialog {...props} onDone={done} />);
}

/**
 * 代替 window.confirm：样式和应用一致，能叠在查看器上面。返回用户是否确认。
 * 用 role="alertdialog"，Esc 只关它自己（查看器和其他弹窗的按键处理只响应最上面的 aria-modal）。
 */
export function confirmDialog(opts: Options): Promise<boolean> {
	return new Promise((resolve) => open(opts, (ok) => resolve(ok)));
}

/** 代替 window.prompt：返回去掉首尾空白的输入，取消或输入为空时返回 null。 */
export function promptDialog({ defaultValue = "", placeholder, ...opts }: PromptOptions): Promise<string | null> {
	return new Promise((resolve) => open({ ...opts, input: { defaultValue, placeholder } }, (ok, value) => resolve(ok && value.trim() ? value.trim() : null)));
}

/** 代替 window.alert：只有一个“知道了”按钮。 */
export function alertDialog(title: string, message?: string): Promise<void> {
	return new Promise((resolve) => open({ title, message, confirmLabel: t.common.gotIt, single: true }, () => resolve()));
}

function ConfirmDialog({ title, message, confirmLabel = t.common.ok, danger, input, single, onDone }: DialogProps) {
	const [closing, setClosing] = useState(false);
	const [value, setValue] = useState(input?.defaultValue ?? "");
	const ref = useRef<HTMLFormElement>(null);
	const okRef = useRef<HTMLButtonElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const valueRef = useRef(value);
	valueRef.current = value;
	const finish = (ok: boolean) => {
		if (closing) return;
		if (ok && input && !valueRef.current.trim()) return;
		setClosing(true);
		onDone(ok, valueRef.current);
	};

	useEffect(() => {
		const prev = document.activeElement as HTMLElement | null;
		if (inputRef.current) inputRef.current.select();
		else okRef.current?.focus();
		const onKey = (e: KeyboardEvent) => {
			const dialogs = document.querySelectorAll('[aria-modal="true"]');
			if (dialogs[dialogs.length - 1] !== ref.current) return;
			if (e.key === "Escape") {
				e.stopImmediatePropagation();
				finish(false);
			} else if (e.key === "Tab") {
				// 焦点只在弹窗里的输入框和按钮之间循环
				const els = [...ref.current!.querySelectorAll<HTMLElement>("input, button:not(:disabled)")];
				const i = els.indexOf(document.activeElement as HTMLElement);
				e.preventDefault();
				els[(i + (e.shiftKey ? els.length - 1 : 1)) % els.length]?.focus();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			prev?.focus?.();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<div
			className={`fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px] ${closing ? "fade-out" : "fade-in"}`}
			onClick={() => finish(false)}
		>
			<form
				ref={ref}
				role="alertdialog"
				aria-modal="true"
				aria-labelledby="confirm-title"
				aria-describedby={message ? "confirm-message" : undefined}
				className={`w-full max-w-sm rounded-3xl bg-card p-5 text-fg shadow-2xl ${closing ? "fade-out" : "pop-in"}`}
				onClick={(e) => e.stopPropagation()}
				onSubmit={(e) => {
					e.preventDefault();
					finish(true);
				}}
			>
				<h2 id="confirm-title" className="text-lg font-bold">
					{title}
				</h2>
				{message && (
					<p id="confirm-message" className="mt-2 text-sm text-muted">
						{message}
					</p>
				)}
				{input && (
					<input
						ref={inputRef}
						className="field mt-4 w-full"
						value={value}
						placeholder={input.placeholder}
						aria-label={title}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={(e) => e.stopPropagation() /* 不触发页面上的快捷键 */}
					/>
				)}
				<div className="mt-5 flex justify-end gap-2">
					{!single && (
						<button type="button" className="btn" onClick={() => finish(false)}>
							{t.common.cancel}
						</button>
					)}
					<button ref={okRef} type="submit" className={danger ? "btn-solid-danger" : "btn-primary"} disabled={!!input && !value.trim()}>
						{confirmLabel}
					</button>
				</div>
			</form>
		</div>
	);
}
