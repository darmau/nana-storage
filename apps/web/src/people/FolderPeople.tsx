import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { t } from "../i18n";
import { openContextMenu } from "../ui/ContextMenu";
import { IconChevronRight, IconClose, IconPeople } from "../ui/icons";
import { FaceAvatar, folderPeopleQuery, personName, personQuery } from "./model";

/**
 * 文件夹页顶部：这个文件夹里的照片中出现的人物（只看本文件夹，不含子文件夹，一次请求）。没有就不显示。
 * 点头像按人物筛选（再点一次取消），筛选时下面的照片可以直接改人物（多选栏换成“这不是 X / 这是其他人物”）。
 * 右键 / 筛选提示里可以打开人物页面。
 * 不用 ul / li：scripts/perf 的脚本把页面上的 `ul li a` 当作相册 / 文件夹卡片。
 */
export function FolderPeople({
	folderId,
	value,
	onChange,
}: {
	folderId: string;
	value: string | undefined;
	onChange: (person: string | undefined) => void;
}) {
	const navigate = useNavigate();
	const { data } = useQuery(folderPeopleQuery(folderId));
	const listed = data?.items.find((p) => p.id === value);
	// 筛选的人物可能已经不在条里（照片全改走了、或者未命名且张数不够），名字单独查
	const person = useQuery({ ...personQuery(value ?? ""), enabled: !!value && !!data && !listed });
	const active = listed ?? person.data;
	if (!data?.items.length && !value) return null;

	const open = (id: string) => void navigate({ to: "/people/$personId", params: { personId: id } });
	return (
		<section aria-label={t.people.inFolder} className="space-y-2">
			<div className="-mx-2 flex gap-3 overflow-x-auto px-2 pb-1 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
				{data?.items.map((p) => {
					const on = p.id === value;
					return (
						<button
							key={p.id}
							type="button"
							aria-pressed={on}
							onClick={() => onChange(on ? undefined : p.id)}
							onContextMenu={(e) =>
								openContextMenu(e, [{ label: t.people.openPerson, icon: <IconPeople size={18} />, onSelect: () => open(p.id) }])
							}
							className={`flex w-16 shrink-0 flex-col items-center gap-1 transition sm:w-20 ${value && !on ? "opacity-50 hover:opacity-80" : ""}`}
							aria-label={t.people.filterByPerson(personName(p))}
							title={t.people.cardLabel(personName(p), p.count)}
						>
							<span className={`block aspect-square w-full rounded-full transition hover:opacity-90 ${on ? "ring-2 ring-accent ring-offset-2 ring-offset-bg" : ""}`}>
								<FaceAvatar face={p.cover} className="h-full w-full" />
							</span>
							<span className={`w-full truncate text-center text-xs font-medium ${p.name ? "" : "text-muted"}`}>{personName(p)}</span>
						</button>
					);
				})}
			</div>
			{value && (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
					<span className="text-muted">{t.people.filteringBy(active ? personName(active) : "…")}</span>
					<Link to="/people/$personId" params={{ personId: value }} className="inline-flex items-center font-medium text-accent hover:underline">
						{t.people.openPerson}
						<IconChevronRight size={16} />
					</Link>
					<button type="button" className="inline-flex items-center gap-1 font-medium text-muted hover:text-fg" onClick={() => onChange(undefined)}>
						<IconClose size={16} />
						{t.people.clearPersonFilter}
					</button>
				</div>
			)}
		</section>
	);
}
