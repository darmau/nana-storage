import type { QueryClient } from "@tanstack/react-query";
import { api, ApiError, errorText } from "../api";
import { t } from "../i18n";
import { invalidateLibrary } from "../library/actions";
import { alertDialog, confirmDialog, promptDialog } from "../ui/confirm";

/**
 * 人物（人脸识别）的数据和通用操作。服务端见 apps/worker/src/people.ts。
 * 头像：每张照片的所有人脸头像横向拼成一张图（/api/a/:assetId/faces?v=），第 idx 格，共 count 格；
 * 头像按用户旋转之前的照片裁切，显示时转 rotation 度。
 */
export interface FaceRef {
	id: string;
	assetId: string;
	idx: number;
	count: number;
	v: number;
	rotation: number;
	/** 照片的派生文件版本号（缩略图地址用） */
	rev: number;
}

export interface Person {
	id: string;
	name: string | null;
	hidden: boolean;
	favorite: boolean;
	/** 照片张数 */
	count: number;
	cover: FaceRef | null;
}

export interface PeopleList {
	items: Person[];
	/** 被隐藏的人物数（只在非隐藏列表里有） */
	hidden: number;
	indexAvailable: boolean;
}

export interface AssetFace extends FaceRef {
	box: { x: number; y: number; w: number; h: number };
	/** 太小、太模糊的脸不参与自动识别，但仍然可以手动指定 */
	recognizable: boolean;
	person: { id: string; name: string | null; hidden: boolean } | null;
}

export const peopleQuery = (hidden = false) => ({
	queryKey: ["people", "list", hidden],
	queryFn: () => api<PeopleList>(`/people${hidden ? "?hidden=1" : ""}`),
});
/** 文件夹里（不含子文件夹）出现的人物，count 是本文件夹里的张数。 */
export const folderPeopleQuery = (folderId: string) => ({
	queryKey: ["people", "folder", folderId],
	queryFn: () => api<{ items: Person[] }>(`/folders/${folderId}/people`),
});
export const personQuery = (id: string) => ({ queryKey: ["people", id], queryFn: () => api<Person>(`/people/${id}`) });
export const assetFacesQuery = (assetId: string) => ({
	queryKey: ["people", "asset", assetId],
	queryFn: () => api<{ scanned: boolean; items: AssetFace[] }>(`/assets/${assetId}/faces`),
	staleTime: 60_000,
});

export const personName = (p: { name: string | null }) => p.name ?? t.people.unnamed;

/** 人物变了：人物列表、人物的照片列表、查看器里的人脸都要刷新。 */
export function invalidatePeople(qc: QueryClient) {
	void qc.invalidateQueries({ queryKey: ["people"] });
	invalidateLibrary(qc);
}

/**
 * 给人物命名 / 改名。名字和另一个人物重复时（409 name taken），问要不要合并成同一个人。
 * 返回最后的人物 id（合并时是另一个人物的 id），取消或失败返回 null。
 */
export async function renamePerson(qc: QueryClient, person: Pick<Person, "id" | "name">): Promise<string | null> {
	const name = await promptDialog({
		title: person.name ? t.people.rename : t.people.addName,
		defaultValue: person.name ?? "",
		placeholder: t.people.namePlaceholder,
		confirmLabel: t.people.done,
	});
	if (!name || name === person.name) return null;
	try {
		await api(`/people/${person.id}`, { method: "PATCH", json: { name } });
		invalidatePeople(qc);
		return person.id;
	} catch (e) {
		if (e instanceof ApiError && e.code === "name taken") {
			const other = (e.body as { personId?: string }).personId;
			if (other && (await confirmDialog({ title: t.people.nameTakenTitle(name), message: t.people.nameTakenMessage, confirmLabel: t.people.merge }))) {
				return mergePeople(qc, other, [person.id]);
			}
			return null;
		}
		void alertDialog(t.people.notSaved, errorText(e));
		return null;
	}
}

/** 从人物中移除这些照片（照片里属于这个人物的脸移出来、重新识别，以后不再自动归回来）。 */
export async function removeFromPerson(qc: QueryClient, personId: string, ids: string[]) {
	const res = await api<{ removed: number }>(`/people/${personId}/remove`, { method: "POST", json: { assetIds: ids } });
	invalidatePeople(qc);
	return res;
}

/** “这是其他人物”：照片里属于 personId 的脸改归到另一个人物（已有的或新名字）。 */
export async function reassignPerson(qc: QueryClient, personId: string, ids: string[], to: { personId: string } | { name: string }) {
	const res = await api<{ personId: string; moved: number }>(`/people/${personId}/reassign`, { method: "POST", json: { assetIds: ids, ...to } });
	invalidatePeople(qc);
	return res;
}

/** 把 from 合并进 into，返回 into。 */
export async function mergePeople(qc: QueryClient, into: string, from: string[]): Promise<string | null> {
	try {
		await api(`/people/${into}/merge`, { method: "POST", json: { ids: from } });
		invalidatePeople(qc);
		return into;
	} catch (e) {
		void alertDialog(t.people.notMerged, errorText(e));
		return null;
	}
}

/**
 * 人脸头像。拼图里第 idx 格：图片宽度是容器的 count 倍，向左平移 idx 格；外层裁成圆形，按照片的旋转角度转过来。
 * 用 <img loading="lazy">，人物很多时只加载看得见的。
 */
export function FaceAvatar({ face, size, className = "" }: { face: FaceRef | null; size?: number; className?: string }) {
	return (
		<span
			className={`relative block shrink-0 overflow-hidden rounded-full bg-surface ${className}`}
			style={size ? { width: size, height: size } : undefined}
			aria-hidden="true"
		>
			{face && (
				<span className="block h-full w-full" style={face.rotation ? { transform: `rotate(${face.rotation}deg)` } : undefined}>
					<img
						src={`/api/a/${face.assetId}/faces?v=${face.v}`}
						alt=""
						loading="lazy"
						decoding="async"
						draggable={false}
						className="block h-full max-w-none select-none"
						style={{ width: `${face.count * 100}%`, transform: `translateX(-${(face.idx / face.count) * 100}%)` }}
					/>
				</span>
			)}
		</span>
	);
}
