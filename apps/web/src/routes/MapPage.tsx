import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { api } from "../api";
import { LibraryList } from "../library/LibraryList";
import { coverUrl } from "../library/queries";
import { ScrollRootContext } from "../library/scrollRoot";
import { useMap } from "../map/useMap";
import { IconClose } from "../ui/icons";
import { useDocumentTitle } from "../ui/title";

interface Point {
	count: number;
	lat: number;
	lon: number;
	cover: string;
	bbox: [number, number, number, number];
}

const VIEW_KEY = "nana:map-view";
const MARKER_PX = 80;

function savedView(): { center: [number, number]; zoom: number } {
	try {
		const v = JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? "null");
		if (v && Array.isArray(v.center) && typeof v.zoom === "number") return v;
	} catch {}
	return { center: [115, 30], zoom: 3.5 };
}

/**
 * 照片地图：按网格聚合（格子约 80 像素宽），每格显示最新一张的缩略图和张数。
 * 地图停止移动 0.25 秒后才请求一次；点击标记在侧边栏列出这一格里的照片。
 *
 * 标记不用 maplibregl.Marker，而是放在地图上方单独的覆盖层里，随地图移动更新位置：
 * MapLibre 会在画布容器的捕获阶段处理按下事件并捕获指针，放在容器里的标记收不到可靠的 click。
 */
export function MapPage() {
	useDocumentTitle(t.nav.map);
	const container = useRef<HTMLDivElement>(null);
	const overlay = useRef<HTMLDivElement>(null);
	const { map, error } = useMap(container, savedView());
	const [selected, setSelected] = useState<Point | null>(null);
	const [panel, setPanel] = useState<HTMLDivElement | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		if (!map) return;
		let markers: { el: HTMLElement; lng: number; lat: number }[] = [];
		let timer: ReturnType<typeof setTimeout> | undefined;
		let controller: AbortController | undefined;
		let raf = 0;

		const place = () => {
			raf = 0;
			for (const m of markers) {
				const p = map.project([m.lng, m.lat]);
				m.el.style.transform = `translate(${p.x - 28}px, ${p.y - 28}px)`;
			}
		};
		const onMove = () => (raf ||= requestAnimationFrame(place));

		const refresh = async () => {
			const b = map.getBounds();
			const w = Math.max(-180, b.getWest());
			const e = Math.min(180, b.getEast());
			const s = Math.max(-90, b.getSouth());
			const n = Math.min(90, b.getNorth());
			const cell = Math.min(45, Math.max(0.0001, ((e - w) / map.getContainer().clientWidth) * MARKER_PX));
			controller?.abort();
			controller = new AbortController();
			try {
				const points = await api<Point[]>(`/map/points?w=${w}&s=${s}&e=${e}&n=${n}&cell=${cell}`, { signal: controller.signal });
				for (const m of markers) m.el.remove();
				markers = points.map((p) => {
					const el = markerElement(p, () => setSelected(p));
					overlay.current?.appendChild(el);
					return { el, lng: p.lon, lat: p.lat };
				});
				place();
				setLoadError(null);
			} catch (err) {
				if ((err as Error).name !== "AbortError") setLoadError(String(err));
			}
			try {
				sessionStorage.setItem(VIEW_KEY, JSON.stringify({ center: map.getCenter().toArray(), zoom: map.getZoom() }));
			} catch {}
		};
		const schedule = () => {
			clearTimeout(timer);
			timer = setTimeout(refresh, 250);
		};
		map.on("moveend", schedule);
		map.on("move", onMove);
		map.on("resize", onMove);
		map.once("load", schedule);
		if (map.loaded()) schedule();
		return () => {
			map.off("moveend", schedule);
			map.off("move", onMove);
			map.off("resize", onMove);
			clearTimeout(timer);
			cancelAnimationFrame(raf);
			controller?.abort();
			for (const m of markers) m.el.remove();
		};
	}, [map]);

	const [w, s, e, n] = selected?.bbox ?? [0, 0, 0, 0];
	return (
		<div className="fixed bottom-[var(--tabbar-h)] left-0 right-0 top-[var(--header-h)] flex md:bottom-0 md:left-[var(--sidebar-w)]">
			<div className="relative h-full flex-1">
				{/* 用 h-full/w-full 而不是 absolute：MapLibre 的 .maplibregl-map 会把 position 改成 relative */}
				<div ref={container} className="h-full w-full" />
				{/* 标记覆盖层：本身不接收事件，只有标记接收 */}
				<div ref={overlay} className="pointer-events-none absolute inset-0 overflow-hidden" />
			</div>
			{(error || loadError) && (
				<p className="absolute left-3 top-3 z-10 rounded-xl bg-card/95 px-3 py-2 text-sm text-danger shadow">{error ?? loadError}</p>
			)}
			{selected && (
				<div
					ref={setPanel}
					className="absolute inset-x-0 bottom-0 z-20 h-[55%] overflow-y-auto rounded-t-3xl bg-card p-4 shadow-2xl sm:static sm:h-full sm:w-[28rem] sm:shrink-0 sm:rounded-none sm:border-l sm:border-border sm:shadow-none"
				>
					<div className="mb-3 flex items-center gap-2">
						<h2 className="flex-1 text-lg font-bold">{t.map.here(selected.count)}</h2>
						<button
							className="btn h-8 px-3 text-xs"
							onClick={() => map?.fitBounds([[w, s], [e, n]], { padding: 40, maxZoom: 17 })}
						>
							{t.map.zoomHere}
						</button>
						<button className="icon-btn !h-9 !w-9 text-muted" onClick={() => setSelected(null)} aria-label={t.common.close}>
							<IconClose size={18} />
						</button>
					</div>
					{panel && (
						<ScrollRootContext.Provider value={panel}>
							<LibraryList
								key={selected.bbox.join(",")}
								source={{ key: ["map", ...selected.bbox], path: `/map/assets?w=${w}&s=${s}&e=${e}&n=${n}` }}
								context={{ kind: "library" }}
								empty={t.map.empty}
							/>
						</ScrollRootContext.Provider>
					)}
				</div>
			)}
		</div>
	);
}

function markerElement(p: Point, onClick: () => void): HTMLElement {
	const el = document.createElement("button");
	el.type = "button";
	el.className =
		"pointer-events-auto absolute left-0 top-0 h-14 w-14 rounded-2xl border-[3px] border-white bg-neutral-300 shadow-[0_2px_10px_rgb(0_0_0/0.3)] transition hover:scale-105 hover:border-accent";
	el.setAttribute("aria-label", t.map.marker(p.count));
	el.dataset.photoMarker = "";
	const img = document.createElement("img");
	img.src = coverUrl(p.cover) ?? "";
	img.alt = "";
	img.className = "h-full w-full rounded-[13px] object-cover";
	img.loading = "lazy";
	el.appendChild(img);
	if (p.count > 1) {
		const badge = document.createElement("span");
		badge.className = "absolute -right-2.5 -top-2.5 min-w-6 rounded-full bg-accent px-1.5 py-0.5 text-center text-[11px] font-bold text-accent-fg shadow";
		badge.textContent = p.count > 999 ? "999+" : String(p.count);
		el.appendChild(badge);
	}
	el.addEventListener("click", onClick);
	return el;
}
