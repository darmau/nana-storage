import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../api";
import { activeCount } from "../upload/UploadStatus";
import { uploader } from "../upload/uploader";
import { invalidateLibrary } from "./actions";

/**
 * 资料库同步：上传和后台处理期间，不用刷新页面，文件夹 / 相册 / 时间线等列表也会自己更新。
 *
 * 做法：每 CHECK_MS 读一次 GET /api/sync（数据版本 + 是否还有任务在处理，服务端只读 2 行）。
 * 版本变了才刷新资料库的查询（invalidateLibrary：正在显示的重新请求，其余标记过期、下次打开时请求），
 * 刷新最多每 MIN_INVALIDATE_MS 一次；列表接口带 ETag，没变的部分回 304。
 *
 * 上限（成本规则：轮询必须有次数上限）：
 *  - 只在“被触发”之后检查：打开应用时检查一次；上传完成一项、文件夹页面看到正在处理的项时重新触发。
 *  - 每次触发后最多再检查 MAX_CHECKS 次（1 小时）。没有上传在进行、服务端也没有任务、没有待刷新的变化时立即停止。
 *  - 标签页在后台时不检查，回到前台时马上补一次。请求出错就停止，等下一次触发。
 * 最坏情况：每小时 360 次检查（360 次 Worker 请求 + 720 行 D1 读取）+ 最多 120 次刷新。
 */

const CHECK_MS = 10_000;
const MIN_INVALIDATE_MS = 30_000;
const MAX_CHECKS = 360;

let remaining = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;
let lastVersion: number | null = null;
let dirty = false;
let lastInvalidate = 0;
let invalidate: (() => void) | null = null;

/** 有新的变化来源（上传、处理）时调用：重新开始计数，没在检查的话马上检查一次。 */
export function armLibrarySync() {
	remaining = MAX_CHECKS;
	if (!invalidate || timer !== undefined || inFlight) return;
	schedule(0);
}

function schedule(ms: number) {
	if (timer !== undefined) clearTimeout(timer);
	timer = setTimeout(() => {
		timer = undefined;
		void check();
	}, ms);
}

async function check() {
	if (!invalidate || remaining <= 0) return;
	if (document.hidden) return; // 回到前台时由 visibilitychange 补上
	remaining--;
	inFlight = true;
	let busy = false;
	try {
		const r = await api<{ v: number; busy: boolean }>("/sync");
		busy = r.busy;
		if (lastVersion !== null && r.v !== lastVersion) dirty = true;
		lastVersion = r.v;
	} catch {
		remaining = 0; // 出错（断网……）就停，等下一次触发
		return;
	} finally {
		inFlight = false;
	}
	if (dirty && Date.now() - lastInvalidate >= MIN_INVALIDATE_MS) {
		dirty = false;
		lastInvalidate = Date.now();
		invalidate?.();
	}
	const uploading = activeCount(uploader.getSnapshot()) > 0;
	if (remaining > 0 && (uploading || busy || dirty)) schedule(CHECK_MS);
	else remaining = 0;
}

/** 挂在外壳上（只挂一次）。卸载时停止。 */
export function useLibrarySync() {
	const qc = useQueryClient();
	useEffect(() => {
		invalidate = () => invalidateLibrary(qc);
		const onVisible = () => {
			if (!document.hidden && remaining > 0 && timer === undefined && !inFlight) schedule(0);
		};
		document.addEventListener("visibilitychange", onVisible);
		armLibrarySync(); // 打开应用时检查一次：上次留下的任务还在处理的话，接着跟进
		return () => {
			document.removeEventListener("visibilitychange", onVisible);
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			invalidate = null;
			remaining = 0;
			lastVersion = null;
			dirty = false;
		};
	}, [qc]);
}
