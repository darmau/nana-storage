#!/usr/bin/env node
// 为官网截图挑选示例照片：从 Openverse 搜 CC0 / 公有领域的照片，写出 demo-photos.json（提交进仓库，之后导入可重复）。
// 每个主题对应一次“旅行”或日常：一个文件夹、一段拍摄时间、一个地点。库存照片没有 EXIF，导入时由 seed-demo.mjs 补上。
//   node site/scripts/pick-photos.mjs
// 只在本地手动运行，请求 Openverse 公共 API（不需要 key），每个主题 1 次请求。
import { writeFileSync } from "node:fs";

const TRIPS = [
	{ folder: "Kyoto", q: ["pagoda", "cherry blossom", "japanese garden"], start: "2023-04-02T09:10", tz: 540, at: [35.0116, 135.7681] },
	{ folder: "Iceland", q: ["waterfall iceland", "glacier", "iceberg"], start: "2023-08-14T11:30", tz: 0, at: [64.1466, -21.9426] },
	{ folder: "Home", q: ["dog", "cat sleeping", "coffee cup"], start: "2024-01-06T08:40", tz: 480, at: [31.2304, 121.4737] },
	{ folder: "Lisbon", q: ["tram", "ocean coast", "old town street"], start: "2024-06-18T17:20", tz: 60, at: [38.7223, -9.1393] },
	{ folder: "Yosemite", q: ["mountain lake", "autumn forest", "mountains valley"], start: "2024-10-03T07:50", tz: -420, at: [37.8651, -119.5383] },
	{ folder: "Paris", q: ["bakery bread", "cafe", "paris street"], start: "2025-03-21T10:05", tz: 60, at: [48.8566, 2.3522] },
	{ folder: "Hong Kong", q: ["city night", "skyline", "harbour boats"], start: "2025-07-09T19:30", tz: 480, at: [22.3193, 114.1694] },
];
const PER_QUERY = 5;
// 不要以人物为主体的照片：库存照片的肖像授权不明，官网上也不该出现可识别的真人
const PEOPLE = /\b(people|person|persons|man|men|woman|women|girl|girls|boy|boys|child|children|kid|kids|model|portrait|face|bikini|fashion|couple|selfie|lady|guy|human)\b/i;

const seen = new Set();
const photos = [];
for (const [ti, trip] of TRIPS.entries()) {
	let n = 0;
	for (const q of trip.q) {
		const url = new URL("https://api.openverse.org/v1/images/");
		url.search = new URLSearchParams({
			q,
			license: "cc0,pdm",
			category: "photograph",
			source: "stocksnap",
			mature: "false",
			page_size: "20",
		}).toString();
		const res = await fetch(url, { headers: { "User-Agent": "nana-storage-site/1.0 (screenshots)" } });
		if (!res.ok) throw new Error(`${q}: ${res.status}`);
		const { results } = await res.json();
		let k = 0;
		for (const r of results) {
			if (k >= PER_QUERY) break;
			if (seen.has(r.id) || !r.url || !r.width || !r.height) continue;
			const words = [r.title ?? "", ...(r.tags ?? []).map((t) => t.name)].join(" ");
			if (PEOPLE.test(words)) continue;
			// 风景为主，竖图少一些，看起来更像手机相册
			seen.add(r.id);
			const start = Date.parse(`${trip.start}:00Z`);
			const day = Math.floor(n / 6);
			const local = new Date(start + day * 86_400_000 + (n % 6) * 47 * 60_000).toISOString().slice(0, 16);
			photos.push({
				id: r.id,
				url: r.url,
				landing: r.foreign_landing_url,
				creator: r.creator ?? null,
				license: r.license,
				title: r.title ?? null,
				folder: trip.folder,
				local,
				tzOffsetMin: trip.tz,
				// 同一趟旅行的照片散在几公里内，地图上能看到聚合
				lat: +(trip.at[0] + (((n * 37) % 11) - 5) * 0.006).toFixed(5),
				lon: +(trip.at[1] + (((n * 53) % 13) - 6) * 0.007).toFixed(5),
				favorite: (ti + n) % 9 === 0,
			});
			k++;
			n++;
		}
		console.log(`${trip.folder} / ${q}: ${k}`);
	}
}
writeFileSync(new URL("./demo-photos.json", import.meta.url), JSON.stringify(photos, null, "\t") + "\n");
console.log(`${photos.length} photos → site/scripts/demo-photos.json`);
