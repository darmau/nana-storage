import { dot, normalize } from "../src/similar";

/** Vectorize 的内存假实现：暴力算余弦相似度。fail 为 true 时所有调用都抛错。 */
export class FakeIndex {
	vectors = new Map<string, number[]>();
	fail = false;
	deleted: string[] = [];
	queries = 0;
	async upsert(vs: { id: string; values: number[] }[]) {
		if (this.fail) throw new Error("vectorize down");
		for (const v of vs) this.vectors.set(v.id, v.values);
		return { mutationId: "m" };
	}
	async deleteByIds(ids: string[]) {
		if (this.fail) throw new Error("vectorize down");
		for (const id of ids) this.vectors.delete(id);
		this.deleted.push(...ids);
		return { mutationId: "m" };
	}
	async query(vector: number[], { topK }: { topK: number }) {
		if (this.fail) throw new Error("vectorize down");
		this.queries++;
		const q = normalize(vector)!;
		const matches = [...this.vectors]
			.map(([id, v]) => ({ id, score: dot(q, normalize(v)!) }))
			.sort((a, b) => b.score - a.score)
			.slice(0, topK);
		return { matches, count: matches.length };
	}
}
