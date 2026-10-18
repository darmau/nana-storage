import type { ExpressionSpecification, StyleSpecification } from "maplibre-gl";
import { locale } from "../i18n";

/**
 * 底图来自 OpenFreeMap（OpenMapTiles 矢量瓦片，免费、不需要 key、每周自动更新）。
 * 浏览器直接请求 tiles.openfreemap.org（CSP 里只放行这一个域名）；照片、点位、缩略图仍然只走本站 /api。
 */
export const MAP_ORIGIN = "https://tiles.openfreemap.org";

export const styleUrl = (dark: boolean) => `${MAP_ORIGIN}/styles/${dark ? "dark" : "positron"}`;

/**
 * 地名按界面语言取：中文界面优先简体中文；英文界面优先英文，没有时用拉丁字母拼写（name_int），
 * 都没有才用当地文字。地图页和信息面板的小地图（找地名）共用这组字段。
 */
export const NAME_FIELDS =
	locale === "zh-CN" ? ["name:zh-Hans", "name:zh", "name"] : ["name:en", "name_int", "name:latin", "name"];

const NAME = ["coalesce", ...NAME_FIELDS.map((k) => ["get", k])] as ExpressionSpecification;

/** 把样式里所有显示地名的标注换成界面语言（道路编号之类不含 name 的不动）。 */
export function localizeStyle(style: StyleSpecification): StyleSpecification {
	return {
		...style,
		layers: style.layers.map((l) => {
			if (l.type !== "symbol" || !JSON.stringify(l.layout?.["text-field"] ?? "").includes('"name')) return l;
			return { ...l, layout: { ...l.layout, "text-field": NAME } };
		}),
	};
}
