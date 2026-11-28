import { lazy, Suspense } from "react";
import type { ViewerProps } from "./Viewer";

let modulePromise: Promise<typeof import("./Viewer")> | null = null;
const loadViewer = () => (modulePromise ??= import("./Viewer"));
const Viewer = lazy(() => loadViewer().then((m) => ({ default: m.Viewer })));

/** 用户表现出打开意图时，与预览图一起提前加载查看器代码。 */
export function preloadViewer() {
	void loadViewer();
}

/** 查看器较大（含编辑、信息、幻灯片），不阻塞照片网格的首屏加载。 */
export function ViewerLoader(props: ViewerProps) {
	return (
		<Suspense fallback={null}>
			<Viewer {...props} />
		</Suspense>
	);
}
