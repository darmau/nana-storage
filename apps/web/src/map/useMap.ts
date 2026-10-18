import { useQuery } from "@tanstack/react-query";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre 6 在运行时拼接 Worker 地址，Vite 识别不了，所以显式把 Worker 文件作为资源输出
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { isDarkTheme } from "../ui/theme";
import { localizeStyle, styleUrl } from "./style";

let workerUrlSet = false;

/**
 * 在 container 里创建地图；返回 map 实例（创建完成前为 null）。
 * static：不能拖动缩放、不带缩放按钮（信息面板里的小地图）。dark 默认跟随外观设置。
 */
export function useMap(
	container: React.RefObject<HTMLDivElement | null>,
	initial: { center: [number, number]; zoom: number },
	opts: { dark?: boolean; static?: boolean } = {},
): { map: maplibregl.Map | null; error: string | null } {
	const dark = opts.dark ?? isDarkTheme();
	const isStatic = !!opts.static;
	// 样式 JSON 先取回来，地名换成界面语言，再交给 MapLibre
	const style = useQuery({
		queryKey: ["map", "style", dark],
		queryFn: async () => {
			const res = await fetch(styleUrl(dark), { credentials: "omit" });
			if (!res.ok) throw new Error(t.map.styleFailed(res.status));
			return localizeStyle(await res.json());
		},
		staleTime: Infinity,
	});
	const [map, setMap] = useState<maplibregl.Map | null>(null);
	const initialRef = useRef(initial);

	useEffect(() => {
		if (!container.current || !style.data) return;
		if (!workerUrlSet) {
			maplibregl.setWorkerUrl(workerUrl);
			workerUrlSet = true;
		}
		const m = new maplibregl.Map({
			container: container.current,
			style: style.data,
			center: initialRef.current.center,
			zoom: initialRef.current.zoom,
			maxZoom: 18,
			interactive: !isStatic,
			attributionControl: { compact: true },
			// 汉字、假名由系统字体在本地渲染，不需要下载 CJK 字形
			localIdeographFontFamily: "'PingFang SC', 'Hiragino Sans', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif",
		});
		if (!isStatic) m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
		setMap(m);
		return () => {
			m.remove();
			setMap(null);
		};
	}, [container, style.data, isStatic]);

	return { map, error: style.error ? String(style.error.message) : null };
}
