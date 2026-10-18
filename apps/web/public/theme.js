// 设置页“外观”选了浅色 / 深色时，在页面渲染之前套用，避免先闪一下系统主题。
// 单独的同源脚本（CSP 只允许 'self'，不能写内联脚本）。只读本机的 localStorage，读不到就跟随系统。
try {
	var t = localStorage.getItem("nana:theme");
	if (t === "light" || t === "dark") {
		document.documentElement.dataset.theme = t;
		var c = t === "dark" ? "#0e0f11" : "#fafaf8";
		document.querySelectorAll('meta[name="theme-color"]').forEach(function (m) {
			m.content = c;
		});
	}
} catch (e) {}
