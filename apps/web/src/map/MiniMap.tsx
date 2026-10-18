import * as maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { NAME_FIELDS } from "./style";
import { useMap } from "./useMap";

/**
 * 信息面板里的小地图：不能拖动，中心是照片位置。地名从已经加载的底图瓦片（OpenMapTiles 的 place 图层）里找最近的，
 * 不请求任何地理编码服务；换照片时复用同一个地图，只移动中心。
 * 底图请求会让 OpenFreeMap 看到这一带的瓦片坐标（和地图页一样），看不到照片本身。
 */
export function MiniMap({ lat, lon, onPlace }: { lat: number; lon: number; onPlace: (name: string | null) => void }) {
	const container = useRef<HTMLDivElement>(null);
	// 查看器总是深色
	const { map, error } = useMap(container, { center: [lon, lat], zoom: ZOOM }, { dark: true, static: true });
	const marker = useRef<maplibregl.Marker | null>(null);
	const [ready, setReady] = useState(false);

	useEffect(() => {
		if (!map) return;
		marker.current = new maplibregl.Marker({ color: "#ff8a80", scale: 0.75 });
		return () => {
			marker.current?.remove();
			marker.current = null;
		};
	}, [map]);

	useEffect(() => {
		if (!map || !marker.current) return;
		onPlace(null);
		map.jumpTo({ center: [lon, lat], zoom: ZOOM });
		marker.current.setLngLat([lon, lat]).addTo(map);
		const onIdle = () => {
			// 小地图上展开的版权说明会盖住大半张图：收成角上的 (i) 按钮，点开仍能看到
			map.getContainer().querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
			setReady(true);
			onPlace(placeName(map, lat, lon));
		};
		map.once("idle", onIdle);
		map.triggerRepaint();
		return () => void map.off("idle", onIdle);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [map, lat, lon]);

	return (
		<div className="relative mt-2 h-36 w-full overflow-hidden rounded-xl bg-surface">
			<div ref={container} className={`h-full w-full transition-opacity ${ready ? "opacity-100" : "opacity-0"}`} />
			{error && <p className="absolute inset-x-0 bottom-2 text-center text-xs text-muted">{error}</p>}
		</div>
	);
}

const ZOOM = 12;

/**
 * 城镇按级别从大到小找，每级只看这么远以内的（标注点在市中心，大城市的范围也大）；
 * 先找到哪一级就用哪一级里最近的，免得市区里的照片被标成旁边的小镇。片区（街道、社区）取 4 km 内最近的。
 */
const LOCALITY_KM: Record<string, number> = { city: 20, town: 8, village: 4, hamlet: 2 };
const LOCALITY_ORDER = ["city", "town", "village", "hamlet"];
const SUBLOCALITY = new Set(["suburb", "quarter", "neighbourhood"]);
const SUBLOCALITY_MAX_KM = 4;

/** “城市 · 片区”，从大到小；找不到就返回 null。 */
export function placeName(map: maplibregl.Map, lat: number, lon: number): string | null {
	const sources = Object.entries(map.getStyle()?.sources ?? {}).filter(([, s]) => s.type === "vector");
	const localities = new Map<string, { name: string; d: number }>();
	let sub: { name: string; d: number } | null = null;
	for (const [id] of sources) {
		for (const f of map.querySourceFeatures(id, { sourceLayer: "place" })) {
			if (f.geometry.type !== "Point") continue;
			const cls = String(f.properties.class ?? "");
			const name = localName(f.properties);
			if (!name) continue;
			const [x, y] = f.geometry.coordinates as [number, number];
			const d = distanceKm(lat, lon, y, x);
			const best = localities.get(cls);
			if (d <= (LOCALITY_KM[cls] ?? -1) && (!best || d < best.d)) localities.set(cls, { name, d });
			else if (SUBLOCALITY.has(cls) && d <= SUBLOCALITY_MAX_KM && (!sub || d < sub.d)) sub = { name, d };
		}
	}
	const locality = LOCALITY_ORDER.map((c) => localities.get(c)).find(Boolean);
	const parts = [locality?.name, sub?.name].filter((n, i, a): n is string => !!n && a.indexOf(n) === i);
	return parts.length ? parts.join(" · ") : null;
}

function localName(p: Record<string, unknown>): string | null {
	for (const k of NAME_FIELDS) {
		const v = p[k];
		if (typeof v === "string" && v) return v;
	}
	return null;
}

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const rad = Math.PI / 180;
	const x = (lon2 - lon1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
	const y = (lat2 - lat1) * rad;
	return Math.hypot(x, y) * 6371;
}
