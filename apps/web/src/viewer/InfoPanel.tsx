import { TRAIT } from "@nana/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";
import { api, errorText } from "../api";
import { t } from "../i18n";
import { invalidateLibrary } from "../library/actions";
import { similarQuery } from "../library/queries";
import { thumbUrl } from "../timeline/types";
import { formatBytes, formatDuration, formatTakenAt } from "../timeline/format";
import { downloadUrl } from "./media";
import { type AssetFace, assetFacesQuery, FaceAvatar, invalidatePeople, personName, renamePerson } from "../people/model";
import { PersonPicker } from "../people/PersonPicker";
import { openMenuAt } from "../ui/ContextMenu";
import type { AssetDetail } from "./types";
import { IconBurst, IconCalendar, IconCamera, IconClose, IconDownload, IconEdit, IconFile, IconFolder, IconPeople, IconPhotos, IconPin, IconRuler } from "../ui/icons";

// 地图库比较大，用到时才加载
const MapPicker = lazy(() => import("../map/MapPicker").then((m) => ({ default: m.MapPicker })));
const MiniMap = lazy(() => import("../map/MiniMap").then((m) => ({ default: m.MiniMap })));

const ROLE_NAMES = t.info.roles;

const TRAIT_NAMES: [number, string][] = [
	[TRAIT.panorama, t.info.traits.panorama],
	[TRAIT.longExposure, t.info.traits.longExposure],
	[TRAIT.portrait, t.info.traits.portrait],
	[TRAIT.raw, t.info.traits.raw],
];

/** 照片类型（连拍、全景、长曝光、人像、RAW），没有时返回 null。 */
export function photoTypes(burstId: string | null, traits: number): string | null {
	const names = TRAIT_NAMES.filter(([bit]) => traits & bit).map(([, name]) => name);
	if (burstId) names.unshift(t.info.traits.burst);
	return names.length ? t.info.joinTypes(names) : null;
}

// 现实中使用的时区偏移（分钟）
export const OFFSETS = [
	-720, -660, -600, -570, -540, -480, -420, -360, -300, -240, -210, -180, -120, -60, 0, 60, 120, 180, 210, 240, 270, 300, 330,
	345, 360, 390, 420, 480, 525, 540, 570, 600, 630, 660, 720, 765, 780, 840,
];
export const offsetLabel = (m: number) => {
	const a = Math.abs(m);
	return `UTC${m >= 0 ? "+" : "-"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
};

/** 解析“31.2304, 121.4737”（可以直接粘贴地图里复制的坐标）。 */
export function parseLatLon(text: string): { lat: number; lon: number } | null {
	const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
	if (!m) return null;
	const lat = Number(m[1]);
	const lon = Number(m[2]);
	return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

const field = "field w-full bg-bg";
const small = "inline-flex h-7 items-center rounded-full border border-border px-3 text-xs font-medium hover:bg-surface disabled:opacity-50";

export function InfoPanel({ asset, onClose }: { asset: AssetDetail; onClose: () => void }) {
	const qc = useQueryClient();
	const [editing, setEditing] = useState<"time" | "location" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const save = async (body: Record<string, unknown>) => {
		setSaving(true);
		setError(null);
		try {
			await api(`/assets/${asset.id}`, { method: "PATCH", json: body });
			invalidateLibrary(qc);
			setEditing(null);
		} catch (e) {
			setError(errorText(e));
		} finally {
			setSaving(false);
		}
	};

	const sources = asset.files.filter((f) => ["original", "raw", "live_video"].includes(f.role));
	const facts: [string, string | null, React.ReactNode][] = [
		[t.info.size, asset.width && asset.height ? `${asset.width} × ${asset.height}` : null, <IconRuler key="r" />],
		[t.info.duration, asset.duration_ms ? formatDuration(asset.duration_ms) : null, <IconCalendar key="d" />],
		[t.info.camera, asset.camera, <IconCamera key="c" />],
		[t.info.lens, asset.lens, <IconCamera key="l" />],
		[t.info.type, photoTypes(asset.burst_id, asset.traits ?? 0), <IconBurst key="t" />],
	];
	const row = "flex gap-3.5 py-2.5";
	const rowIcon = "mt-0.5 shrink-0 text-muted";

	return (
		<aside className="panel-in absolute inset-x-0 bottom-0 z-20 max-h-[62%] overflow-y-auto rounded-t-3xl border-t border-border bg-card px-5 pb-[max(1.5rem,var(--safe-bottom))] pt-3 text-sm text-fg shadow-2xl sm:static sm:max-h-none sm:w-[22rem] sm:shrink-0 sm:rounded-none sm:border-l sm:border-t-0 sm:pt-4 sm:shadow-none">
			<span aria-hidden="true" className="mx-auto mb-3 block h-1 w-10 rounded-full bg-border sm:hidden" />
			<div className="mb-4 flex items-center justify-between">
				<h2 className="text-lg font-bold">{t.info.title}</h2>
				<button className="-mr-2 flex h-10 w-10 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-fg" onClick={onClose} aria-label={t.info.close}>
					<IconClose size={18} />
				</button>
			</div>

			<DescriptionField key={asset.id} initial={asset.description ?? ""} onSave={(d) => save({ description: d })} />

			<PeopleStrip assetId={asset.id} />

			<h3 className="mb-1 mt-6 text-xs font-semibold text-muted">{t.info.details}</h3>
			<dl>
				<div className={row}>
					<IconCalendar className={rowIcon} />
					<div className="min-w-0 flex-1">
						<dt className="flex items-center justify-between text-xs text-muted">
							{t.info.takenAt}
							{editing !== "time" && (
								<button className={small} onClick={() => setEditing("time")}>
									{t.info.edit}
								</button>
							)}
						</dt>
						{editing === "time" ? (
							<TimeEditor asset={asset} saving={saving} onCancel={() => setEditing(null)} onSave={(takenAt) => save({ takenAt })} />
						) : (
							<dd className="mt-0.5">{formatTakenAt(asset.taken_at, asset.tz_offset_min)}</dd>
						)}
					</div>
				</div>

				<div className={row}>
					<IconPin className={rowIcon} />
					<div className="min-w-0 flex-1">
						<dt className="flex items-center justify-between text-xs text-muted">
							{t.info.location}
							{editing !== "location" && (
								<button className={small} onClick={() => setEditing("location")}>
									{asset.lat !== null ? t.info.edit : t.info.add}
								</button>
							)}
						</dt>
						{editing === "location" ? (
							<LocationEditor asset={asset} saving={saving} onCancel={() => setEditing(null)} onSave={(loc) => save({ location: loc })} />
						) : (
							<dd className="mt-0.5">
								{asset.lat !== null && asset.lon !== null ? (
									<LocationView lat={asset.lat} lon={asset.lon} />
								) : (
									<span className="text-muted">{t.info.none}</span>
								)}
							</dd>
						)}
					</div>
				</div>

				<div className={row}>
					<IconFolder className={rowIcon} />
					<div className="min-w-0 flex-1">
						<dt className="text-xs text-muted">{t.info.folder}</dt>
						<dd className="mt-0.5 break-words">
							<FolderPath path={asset.folder_path ?? []} />
						</dd>
					</div>
				</div>

				{facts
					.filter(([, v]) => v)
					.map(([k, v, ic]) => (
						<div key={k} className={row}>
							<span className={rowIcon}>{ic}</span>
							<div className="min-w-0 flex-1">
								<dt className="text-xs text-muted">{k}</dt>
								<dd className="mt-0.5 break-words">{v}</dd>
							</div>
						</div>
					))}
			</dl>
			{error && <p className="mt-3 text-xs text-danger">{t.info.saveFailed(error)}</p>}

			<SimilarStrip assetId={asset.id} />

			<h3 className="mb-1 mt-6 text-xs font-semibold text-muted">{t.info.files}</h3>
			<ul>
				{sources.map((f) => (
					<li key={f.role} className="flex items-center gap-3.5 py-2.5">
						<IconFile className={rowIcon} />
						<div className="min-w-0 flex-1">
							<div className="truncate">{f.original_name ?? ROLE_NAMES[f.role]}</div>
							<div className="text-xs text-muted">
								{ROLE_NAMES[f.role]} · {f.mime} · {formatBytes(f.size)}
							</div>
						</div>
						<a
							className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border hover:bg-surface"
							href={downloadUrl(asset.id, f.role)}
							aria-label={t.info.downloadRole(ROLE_NAMES[f.role] ?? f.role)}
							title={t.info.download}
						>
							<IconDownload size={16} />
						</a>
					</li>
				))}
			</ul>
		</aside>
	);
}

/**
 * 照片里的人物（只在信息面板打开时请求）。点一张脸弹出菜单：查看这个人物、指定 / 更改是谁、“这不是 X”。
 * 太小、太模糊的脸不参与自动识别，也不显示，除非已经手动指定过。
 */
function PeopleStrip({ assetId }: { assetId: string }) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const { data } = useQuery(assetFacesQuery(assetId));
	const [assigning, setAssigning] = useState<AssetFace | null>(null);
	const [error, setError] = useState<string | null>(null);
	const faces = data?.items.filter((f) => f.person || f.recognizable) ?? [];
	if (!faces.length) return null;

	const act = async (fn: () => Promise<unknown>) => {
		setError(null);
		try {
			await fn();
			invalidatePeople(qc);
		} catch (e) {
			setError(errorText(e));
		}
	};
	const menu = (el: HTMLElement, f: AssetFace) => {
		const p = f.person;
		openMenuAt(el, [
			...(p
				? [
						{
							label: t.info.viewPerson(personName(p)),
							icon: <IconPeople size={18} />,
							onSelect: () => void navigate({ to: "/people/$personId", params: { personId: p.id } }),
						},
					]
				: []),
			...(p
				? [
						{
							label: t.info.setPersonCover(personName(p)),
							icon: <IconPhotos size={18} />,
							onSelect: () => void act(() => api(`/people/${p.id}`, { method: "PATCH", json: { coverFaceId: f.id } })),
						},
					]
				: []),
			...(p && !p.name ? [{ label: t.info.addNameMenu, icon: <IconEdit size={18} />, onSelect: () => void renamePerson(qc, p) }] : []),
			{ label: p ? t.info.changePerson : t.info.whoMenu, icon: <IconPeople size={18} />, onSelect: () => setAssigning(f) },
			...(p
				? [
						{
							label: t.info.notPerson(personName(p)),
							icon: <IconClose size={18} />,
							onSelect: () => void act(() => api(`/faces/${f.id}/reject`, { method: "POST", json: { personId: p.id } })),
						},
					]
				: []),
		]);
	};

	return (
		<section>
			<h3 className="mb-2 mt-6 text-xs font-semibold text-muted">{t.info.people}</h3>
			<ul className="flex flex-wrap gap-x-2 gap-y-3">
				{faces.map((f) => (
					<li key={f.id} className="w-16">
						<button
							className="flex w-full flex-col items-center gap-1 rounded-xl text-xs hover:opacity-85"
							aria-haspopup="menu"
							onClick={(e) => menu(e.currentTarget, f)}
						>
							<FaceAvatar face={f} size={52} />
							<span className={`w-full truncate text-center ${f.person?.name ? "" : "text-muted"}`}>
								{f.person ? personName(f.person) : t.info.addName}
							</span>
						</button>
					</li>
				))}
			</ul>
			{error && <p className="mt-2 text-xs text-danger">{error}</p>}
			{assigning && (
				<PersonPicker
					title={t.actions.whoIsThis}
					allowNew
					exclude={assigning.person ? [assigning.person.id] : []}
					onClose={() => setAssigning(null)}
					onPick={(pick) => {
						const face = assigning;
						setAssigning(null);
						void act(() =>
							api(`/faces/${face.id}/assign`, { method: "POST", json: "person" in pick ? { personId: pick.person.id } : { name: pick.name } }),
						);
					}}
				/>
			)}
		</section>
	);
}

/** 最多显示几张相似照片，其余点“全部”。 */
const SIMILAR_PREVIEW = 8;

/** 相似照片：只在信息面板打开时请求一次（缓存 1 分钟）。点开进入相似照片页。 */
function SimilarStrip({ assetId }: { assetId: string }) {
	const { data } = useQuery(similarQuery(assetId));
	if (!data || data.unavailable || (data.fingerprinted && !data.items.length)) return null;
	return (
		<section>
			<h3 className="mb-2 mt-6 flex items-center justify-between text-xs font-semibold text-muted">
				{t.info.similar}
				{data.items.length > SIMILAR_PREVIEW && (
					<Link to="/similar/$assetId" params={{ assetId }} className={small}>
						{t.info.similarAll(data.items.length)}
					</Link>
				)}
			</h3>
			{!data.fingerprinted ? (
				<p className="text-xs text-muted">{t.info.noFingerprint}</p>
			) : (
				<ul className="grid grid-cols-4 gap-1.5">
					{data.items.slice(0, SIMILAR_PREVIEW).map((it) => (
						<li key={it[0]}>
							<Link
								to="/similar/$assetId"
								params={{ assetId }}
								search={{ a: it[0] }}
								className="block aspect-square overflow-hidden rounded-lg bg-surface"
								aria-label={t.info.openSimilar}
							>
								<img src={thumbUrl(it[0], it[7])} alt="" loading="lazy" className="h-full w-full object-cover" />
							</Link>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

/** 所在文件夹的路径，每一级都能点进去。 */
function FolderPath({ path }: { path: { id: string; name: string }[] }) {
	const crumbs = [{ id: "root", name: t.pickers.root }, ...path];
	return (
		<>
			{crumbs.map((f, i) => (
				<span key={f.id}>
					{i > 0 && <span className="mx-1 text-muted">/</span>}
					<Link to="/folders/$folderId" params={{ folderId: f.id }} className="hover:underline">
						{f.name}
					</Link>
				</span>
			))}
		</>
	);
}

/** 描述：失焦时如果有变化就保存。 */
function DescriptionField({ initial, onSave }: { initial: string; onSave: (d: string) => void }) {
	const [value, setValue] = useState(initial);
	useEffect(() => setValue(initial), [initial]);
	return (
		<textarea
			className={`${field} min-h-20 resize-y`}
			placeholder={t.info.descriptionPlaceholder}
			maxLength={2000}
			value={value}
			onChange={(e) => setValue(e.target.value)}
			onBlur={() => value.trim() !== initial.trim() && onSave(value)}
			onKeyDown={(e) => e.stopPropagation() /* 不触发查看器的快捷键 */}
		/>
	);
}

function TimeEditor({
	asset,
	saving,
	onSave,
	onCancel,
}: {
	asset: AssetDetail;
	saving: boolean;
	onSave: (t: { local: string; tzOffsetMin: number }) => void;
	onCancel: () => void;
}) {
	const base = asset.taken_at ?? Date.now();
	const initialTz = asset.tz_offset_min ?? -new Date(base).getTimezoneOffset();
	const [tz, setTz] = useState(initialTz);
	const [local, setLocal] = useState(new Date(base + initialTz * 60_000).toISOString().slice(0, 19));
	const offsets = OFFSETS.includes(initialTz) ? OFFSETS : [...OFFSETS, initialTz].sort((a, b) => a - b);
	return (
		<dd className="mt-1 space-y-2" onKeyDown={(e) => e.stopPropagation()}>
			<input type="datetime-local" step={1} className={field} value={local} onChange={(e) => setLocal(e.target.value)} />
			<select className={field} value={tz} onChange={(e) => setTz(Number(e.target.value))} aria-label={t.meta.timezone}>
				{offsets.map((o) => (
					<option key={o} value={o}>
						{offsetLabel(o)}
					</option>
				))}
			</select>
			<div className="flex gap-2">
				<button className={small} disabled={saving || !local} onClick={() => onSave({ local, tzOffsetMin: tz })}>
					{t.common.save}
				</button>
				<button className={small} onClick={onCancel}>
					{t.common.cancel}
				</button>
			</div>
		</dd>
	);
}

/** 地名（从底图里找，找不到就不显示）+ 经纬度 + 小地图 */
function LocationView({ lat, lon }: { lat: number; lon: number }) {
	const [place, setPlace] = useState<string | null>(null);
	return (
		<>
			{place && <div className="break-words">{place}</div>}
			<div className={`tabular-nums ${place ? "text-xs text-muted" : ""}`}>
				{lat.toFixed(5)}, {lon.toFixed(5)}
			</div>
			<Suspense fallback={<div className="mt-2 h-36 w-full rounded-xl bg-surface" />}>
				<MiniMap lat={lat} lon={lon} onPlace={setPlace} />
			</Suspense>
		</>
	);
}

function LocationEditor({
	asset,
	saving,
	onSave,
	onCancel,
}: {
	asset: AssetDetail;
	saving: boolean;
	onSave: (loc: { lat: number; lon: number } | null) => void;
	onCancel: () => void;
}) {
	const [text, setText] = useState(asset.lat !== null && asset.lon !== null ? `${asset.lat}, ${asset.lon}` : "");
	const [picking, setPicking] = useState(false);
	const parsed = parseLatLon(text);
	return (
		<dd className="mt-1 space-y-2" onKeyDown={(e) => e.stopPropagation()}>
			<input
				className={field}
				placeholder={t.meta.latLonPlaceholder}
				value={text}
				onChange={(e) => setText(e.target.value)}
				aria-invalid={!!text && !parsed}
			/>
			{text && !parsed && <p className="text-xs text-danger">{t.meta.latLonInvalid}</p>}
			<div className="flex flex-wrap gap-2">
				<button className={small} onClick={() => setPicking(true)}>
					{t.meta.pickOnMap}
				</button>
				<button className={small} disabled={saving || !parsed} onClick={() => parsed && onSave(parsed)}>
					{t.common.save}
				</button>
				{asset.lat !== null && (
					<button className={small} disabled={saving} onClick={() => onSave(null)}>
						{t.info.clearLocation}
					</button>
				)}
				<button className={small} onClick={onCancel}>
					{t.common.cancel}
				</button>
			</div>
			{picking && (
				<Suspense fallback={null}>
					<MapPicker
						initial={parsed}
						onClose={() => setPicking(false)}
						onPick={(loc) => {
							setPicking(false);
							onSave(loc);
						}}
					/>
				</Suspense>
			)}
		</dd>
	);
}
