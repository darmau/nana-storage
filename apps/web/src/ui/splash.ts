/**
 * 移除 index.html 里的启动画面：外壳第一次渲染之后调用（只有第一次有效）。
 * 先淡出再删掉；减少动态效果时没有动画，到时间直接删。
 */
export function hideSplash() {
	const el = document.getElementById("splash");
	if (!el || el.classList.contains("app-splash-out")) return;
	// 普通标签页里启动画面延迟才显示：还没露出来就直接删，不先闪出来再淡出
	if (Number(getComputedStyle(el).opacity) < 0.05) return el.remove();
	el.classList.add("app-splash-out");
	setTimeout(() => el.remove(), 220);
}
