import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { api, errorText } from "../api";
import { t } from "../i18n";
import { LibraryList } from "../library/LibraryList";
import type { ListSource } from "../library/queries";
import { TypeFilter, useTypeFilter, withType } from "../library/TypeFilter";
import { FaceAvatar, invalidatePeople, mergePeople, peopleQuery, type Person, personName, personQuery, renamePerson } from "../people/model";
import { PersonPicker } from "../people/PersonPicker";
import { ReviewDialog } from "../people/ReviewDialog";
import { alertDialog, confirmDialog } from "../ui/confirm";
import { type MenuItem, openContextMenu } from "../ui/ContextMenu";
import { IconCheck, IconChevronRight, IconEdit, IconEyeOff, IconHeart, IconMerge, IconPeople } from "../ui/icons";
import { PageActions, SlideshowButton } from "./LibraryPages";
import { useDocumentTitle } from "../ui/title";

/** 人物的通用操作（列表的右键菜单和人物页的页头共用）。 */
function usePersonActions() {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const [merging, setMerging] = useState<Person | null>(null);
	const [reviewing, setReviewing] = useState<Person | null>(null);

	const patch = async (p: Person, body: Record<string, unknown>) => {
		try {
			await api(`/people/${p.id}`, { method: "PATCH", json: body });
			invalidatePeople(qc);
		} catch (e) {
			void alertDialog(t.people.notSaved, errorText(e));
		}
	};
	const rename = async (p: Person) => {
		const id = await renamePerson(qc, p);
		if (id && id !== p.id) void navigate({ to: "/people/$personId", params: { personId: id }, replace: true });
	};
	const toggleHidden = async (p: Person) => {
		if (!p.hidden && !(await confirmDialog({ title: t.people.hideTitle(personName(p)), message: t.people.hideMessage, confirmLabel: t.people.hide })))
			return;
		await patch(p, { hidden: !p.hidden });
	};

	const actions = (p: Person) => ({
		rename: { label: p.name ? t.people.rename : t.people.addName, icon: <IconEdit size={18} />, onSelect: () => void rename(p) },
		favorite: {
			label: p.favorite ? t.people.unfavorite : t.people.favorite,
			icon: <IconHeart size={18} filled={p.favorite} />,
			onSelect: () => void patch(p, { favorite: !p.favorite }),
		},
		review: { label: t.people.review, icon: <IconCheck size={18} />, onSelect: () => setReviewing(p) },
		merge: { label: t.people.mergeWith, icon: <IconMerge size={18} />, onSelect: () => setMerging(p) },
		hide: { label: p.hidden ? t.people.unhide : t.people.hide, icon: <IconEyeOff size={18} />, onSelect: () => void toggleHidden(p) },
	});

	const dialogs = (
		<>
			{reviewing && <ReviewDialog person={reviewing} onClose={() => setReviewing(null)} />}
			{merging && (
				<PersonPicker
					title={t.people.mergeInto(personName(merging))}
					exclude={[merging.id]}
					onClose={() => setMerging(null)}
					onPick={async (pick) => {
						if (!("person" in pick)) return;
						const from = merging;
						setMerging(null);
						const ok = await confirmDialog({
							title: t.people.mergeConfirm(personName(pick.person)),
							message: t.people.mergeMessage,
							confirmLabel: t.people.merge,
						});
						if (!ok) return;
						// 被合并的一方没有名字、另一方有时，名字保留下来
						const into = await mergePeople(qc, pick.person.id, [from.id]);
						if (into) void navigate({ to: "/people/$personId", params: { personId: into }, replace: true });
					}}
				/>
			)}
		</>
	);
	return { actions, dialogs };
}

/**
 * 人物列表（参照 iOS 相册）：个人收藏的人物排在最上面、头像更大；然后是其他人物，未命名的显示“添加名字”。
 * 只在打开时请求一次，不轮询。
 */
export function PeoplePage() {
	const [showHidden, setShowHidden] = useState(false);
	useDocumentTitle(showHidden ? t.people.hiddenPeople : t.people.title);
	const { data, error } = useQuery(peopleQuery(showHidden));
	const { actions, dialogs } = usePersonActions();
	const navigate = useNavigate();
	const qc = useQueryClient();

	const menu = (e: React.MouseEvent, p: Person) => {
		const a = actions(p);
		const items: MenuItem[] = [
			{ label: t.library.open, icon: <IconPeople size={18} />, onSelect: () => void navigate({ to: "/people/$personId", params: { personId: p.id } }) },
			a.rename,
			a.favorite,
			a.review,
			a.merge,
			"sep",
			a.hide,
		];
		openContextMenu(e, items);
	};

	const favorites = showHidden ? [] : (data?.items.filter((p) => p.favorite) ?? []);
	const others = data?.items.filter((p) => showHidden || !p.favorite) ?? [];

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-2 pt-1">
				{showHidden ? (
					<div className="flex min-w-0 flex-1 items-center gap-1 text-xl font-bold tracking-tight sm:text-2xl">
						<button className="shrink-0 text-muted hover:text-fg" onClick={() => setShowHidden(false)}>
							{t.people.title}
						</button>
						<IconChevronRight size={20} className="shrink-0 text-muted" />
						<h1>{t.people.hidden}</h1>
					</div>
				) : (
					<h1 className="page-title flex-1">{t.people.title}</h1>
				)}
				{!showHidden && !!data?.hidden && (
					<button className="btn" onClick={() => setShowHidden(true)}>
						<IconEyeOff size={18} />
						{t.people.hiddenCount(data.hidden)}
					</button>
				)}
			</div>
			{error && <p className="text-danger">{t.common.loadFailed(errorText(error))}</p>}
			{data && !data.items.length && (
				<div className="space-y-2 py-16 text-center text-sm text-muted">
					{showHidden ? (
						<p>{t.people.noHidden}</p>
					) : !data.indexAvailable ? (
						<p>{t.people.indexUnavailable}</p>
					) : (
						<p>{t.people.none}</p>
					)}
				</div>
			)}

			{favorites.length > 0 && (
				<ul className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6">
					{favorites.map((p) => (
						<PersonCard key={p.id} person={p} big onMenu={menu} onName={() => void renamePerson(qc, p)} />
					))}
				</ul>
			)}
			{others.length > 0 && (
				<ul className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-5 lg:grid-cols-7 xl:grid-cols-9">
					{others.map((p) => (
						<PersonCard key={p.id} person={p} onMenu={menu} onName={() => void renamePerson(qc, p)} />
					))}
				</ul>
			)}
			{dialogs}
		</div>
	);
}

/** 头像 + 名字。未命名的在头像下面显示“添加名字”按钮（不在链接里，点了直接命名）。 */
function PersonCard({
	person,
	big,
	onMenu,
	onName,
}: {
	person: Person;
	big?: boolean;
	onMenu: (e: React.MouseEvent, p: Person) => void;
	onName: () => void;
}) {
	return (
		<li className="flex min-w-0 flex-col items-center gap-1.5" onContextMenu={(e) => onMenu(e, person)}>
			<Link
				to="/people/$personId"
				params={{ personId: person.id }}
				className="block w-full rounded-full transition hover:opacity-90"
				aria-label={t.people.cardLabel(personName(person), person.count)}
			>
				<span className={`mx-auto block aspect-square w-full ${big ? "max-w-36" : "max-w-28"}`}>
					<FaceAvatar face={person.cover} className="h-full w-full" />
				</span>
			</Link>
			{person.name ? (
				<div className="w-full truncate text-center text-sm font-medium" title={person.name}>
					{person.name}
				</div>
			) : (
				<button className="text-sm font-medium text-accent hover:underline" onClick={onName}>
					{t.people.addName}
				</button>
			)}
			<div className="-mt-1 text-xs tabular-nums text-muted">{person.count}</div>
		</li>
	);
}

/** 一个人物的照片：页头是头像和名字，下面和相册一样（类型筛选、多选、幻灯片、查看器）。 */
export function PersonPage() {
	const { personId } = useParams({ strict: false }) as { personId: string };
	const qc = useQueryClient();
	const [type, setType] = useTypeFilter();
	const person = useQuery(personQuery(personId));
	useDocumentTitle(person.data ? personName(person.data) : null);
	const { actions, dialogs } = usePersonActions();
	const source: ListSource = { key: ["person", personId, type], path: withType(`/people/${personId}/assets`, type) };
	const p = person.data;

	if (person.error) return <p className="text-danger">{errorText(person.error)}</p>;
	const a = p ? actions(p) : null;
	return (
		<div className="space-y-6">
			<div className="flex items-center gap-2 pt-1">
				<div className="flex min-w-0 flex-1 items-center gap-1 text-xl font-bold tracking-tight sm:text-2xl">
					<Link to="/people" className="shrink-0 text-muted hover:text-fg">
						{t.people.title}
					</Link>
					<IconChevronRight size={20} className="shrink-0 text-muted" />
					<h1 className={`truncate ${p?.name ? "" : "text-muted"}`} title={p?.name ?? undefined}>
						{p ? personName(p) : ""}
					</h1>
				</div>
				<SlideshowButton key={`${personId}:${type}`} source={source} />
				{/* “确认更多照片”和“添加名字”在头像旁边有按钮，其余收进“更多” */}
				{a && <PageActions menu={[a.rename, a.favorite, a.merge, a.hide]} />}
			</div>
			{p && (
				<div className="flex items-center gap-4">
					<FaceAvatar face={p.cover} size={88} />
					<div className="min-w-0 space-y-1.5">
						<div className="text-sm text-muted">
							{t.people.photoCount(p.count)}
							{p.hidden && t.people.hiddenTag}
							{p.favorite && t.people.favoriteTag}
						</div>
						<div className="flex flex-wrap gap-2">
							{!p.name && (
								<button className="btn-primary" onClick={a!.rename.onSelect}>
									{t.people.addName}
								</button>
							)}
							<button className="btn" onClick={a!.review.onSelect}>
								<IconCheck size={18} />
								{t.people.review}
							</button>
						</div>
					</div>
				</div>
			)}
			<TypeFilter value={type} onChange={setType} />
			<LibraryList
				key={`${personId}:${type}`}
				source={source}
				context={{ kind: "person", personId, name: p?.name ?? null }}
				empty={type ? t.people.emptyType : t.people.empty}
			/>
			{dialogs}
		</div>
	);
}
