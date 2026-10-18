import * as maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { Modal } from "../library/Modal";
import { useMap } from "./useMap";

/** 在地图上点一下选位置。 */
export function MapPicker({
	initial,
	onPick,
	onClose,
}: {
	initial: { lat: number; lon: number } | null;
	onPick: (loc: { lat: number; lon: number }) => void;
	onClose: () => void;
}) {
	const container = useRef<HTMLDivElement>(null);
	const { map, error } = useMap(container, initial ? { center: [initial.lon, initial.lat], zoom: 13 } : { center: [115, 30], zoom: 3.5 });
	const [picked, setPicked] = useState(initial);

	useEffect(() => {
		if (!map) return;
		const marker = new maplibregl.Marker({ draggable: true });
		if (initial) marker.setLngLat([initial.lon, initial.lat]).addTo(map);
		const round = (v: number) => Math.round(v * 1e6) / 1e6;
		const set = (lng: number, lat: number) => setPicked({ lat: round(lat), lon: round(lng) });
		map.on("click", (e) => {
			marker.setLngLat(e.lngLat).addTo(map);
			set(e.lngLat.lng, e.lngLat.lat);
		});
		marker.on("dragend", () => {
			const p = marker.getLngLat();
			set(p.lng, p.lat);
		});
		return () => void marker.remove();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [map]);

	return (
		<Modal title={t.map.pickTitle} onClose={onClose}>
			<div ref={container} className="h-80 w-full overflow-hidden rounded-lg" />
			{error && <p className="mt-2 text-xs text-danger">{error}</p>}
			<div className="mt-3 flex items-center gap-2 text-sm">
				<span className="flex-1 text-muted">{picked ? `${picked.lat}, ${picked.lon}` : t.map.pickHint}</span>
				<button className="btn-primary" disabled={!picked} onClick={() => picked && onPick(picked)}>
					{t.map.usePlace}
				</button>
			</div>
		</Modal>
	);
}
