// 官网和使用文档。纯静态，部署到 GitHub Pages（.github/workflows/site.yml）。
// 首页是自己的页面（src/pages/index.astro、en/index.astro），文档由 Starlight 生成在 /docs/ 下。
// 不加载任何第三方资源：没有 Web 字体、统计、CDN。
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

const group = (label, en, items) => ({ label, translations: { en }, items });
const page = (slug) => ({ slug: `docs/${slug}` });

export default defineConfig({
	site: "https://darmau.github.io",
	base: "/nana-storage",
	trailingSlash: "always",
	integrations: [
		starlight({
			title: { "zh-CN": "那时", en: "Nana" },
			description: "部署在你自己 Cloudflare 账号上的私人相册",
			logo: { src: "./src/assets/logo.svg", replacesTitle: false },
			favicon: "/favicon.svg",
			defaultLocale: "root",
			locales: {
				root: { label: "简体中文", lang: "zh-CN" },
				en: { label: "English", lang: "en" },
			},
			social: [{ icon: "github", label: "GitHub", href: "https://github.com/darmau/nana-storage" }],
			editLink: { baseUrl: "https://github.com/darmau/nana-storage/edit/main/site/" },
			customCss: ["./src/styles/tokens.css", "./src/styles/docs.css"],
			credits: false,
			lastUpdated: false,
			sidebar: [
				group("开始", "Getting started", [page("introduction"), page("architecture"), page("costs")]),
				group("部署", "Deploy", [
					page("deploy/prepare"),
					page("deploy/setup"),
					page("deploy/workers-builds"),
					page("deploy/checklist"),
					page("deploy/options"),
					page("deploy/updating"),
				]),
				group("使用", "Using Nana", [
					page("guide/upload"),
					page("guide/browse"),
					page("guide/organize"),
					page("guide/edit"),
					page("guide/search"),
					page("guide/map"),
					page("guide/people"),
					page("guide/similar"),
					page("guide/settings"),
					page("guide/pwa"),
				]),
				group("设备端处理", "On-device processing", [
					page("device/install"),
					page("device/local-originals"),
					page("device/upload"),
					page("device/security"),
				]),
				group("安全与隐私", "Security & privacy", [page("security/model"), page("security/data"), page("security/report")]),
				group("排错", "Help", [
					page("help/deploy-errors"),
					page("help/jobs"),
					page("help/playback"),
					page("help/backup"),
					page("help/limitations"),
					page("help/faq"),
				]),
				group("更多", "More", [page("contributing"), page("credits")]),
			],
		}),
	],
});
