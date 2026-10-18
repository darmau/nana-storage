import { FP_DIMS } from "@nana/shared";

/**
 * 主题的分类器：在 CLIP 图像向量上做 L2 正则的逻辑回归，p = sigmoid(w·x + b)，x 是归一化后的向量。
 *
 * 训练数据：正例（用户确认的）、负例（用户点了“不是”的）、背景（从全库随机抽的照片，权重低）。
 * 背景让分类器知道“哪些特征到处都有”（地板、天空、人像），从而只抓住正例真正共有的东西。
 * 正负两类按总权重各占一半，所以例子的多少不会改变分数的尺度。
 *
 * 训练前减去背景的平均向量（CLIP 向量之间有很大的公共分量，不减的话梯度下降很慢），
 * 训练完再把它折进偏置，打分时不需要知道这个平均值。
 * 轮数固定（Adam，SMART_SET_TRAIN_STEPS 步），最坏情况约 1300 个样本 × 512 维 × 200 步 ≈ 1.3 亿次乘加。
 */

export interface Classifier {
	w: Float32Array;
	b: number;
}

/** 背景照片的权重（相对用户标的负例）。随机抽的照片里偶尔也会有正例，权重低一些影响就小。 */
const BACKGROUND_WEIGHT = 0.3;
const STEPS = 200;
const LEARNING_RATE = 0.05;
/** 正则强度：太小分数会全部挤到 0 或 1，太大就分不开。 */
const L2 = 1e-3;

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/**
 * 训练。向量都应该已经归一化。没有正例，或者没有任何负例 / 背景时返回 null。
 */
export function trainClassifier(pos: Float32Array[], neg: Float32Array[], background: Float32Array[]): Classifier | null {
	if (!pos.length || !(neg.length + background.length)) return null;
	const xs = [...pos, ...neg, ...background];
	const ys = xs.map((_, i) => (i < pos.length ? 1 : 0));
	// 每类总权重 0.5：正例平分；负例 1、背景 BACKGROUND_WEIGHT，再整体缩放
	const negMass = neg.length + background.length * BACKGROUND_WEIGHT;
	const cs = xs.map((_, i) =>
		i < pos.length ? 0.5 / pos.length : i < pos.length + neg.length ? 0.5 / negMass : (0.5 * BACKGROUND_WEIGHT) / negMass,
	);

	// 中心：背景的平均（没有背景时用全部样本）
	const centerFrom = background.length ? background : xs;
	const mu = new Float64Array(FP_DIMS);
	for (const x of centerFrom) for (let d = 0; d < FP_DIMS; d++) mu[d]! += x[d]!;
	for (let d = 0; d < FP_DIMS; d++) mu[d]! /= centerFrom.length;
	const centered = xs.map((x) => Float64Array.from(x, (v, d) => v - mu[d]!));

	// Adam
	const n = FP_DIMS + 1; // 最后一个是偏置
	const theta = new Float64Array(n);
	const m = new Float64Array(n);
	const v = new Float64Array(n);
	const g = new Float64Array(n);
	const b1 = 0.9;
	const b2 = 0.999;
	for (let step = 1; step <= STEPS; step++) {
		g.fill(0);
		for (let i = 0; i < centered.length; i++) {
			const x = centered[i]!;
			let z = theta[FP_DIMS]!;
			for (let d = 0; d < FP_DIMS; d++) z += theta[d]! * x[d]!;
			const err = cs[i]! * (sigmoid(z) - ys[i]!);
			for (let d = 0; d < FP_DIMS; d++) g[d]! += err * x[d]!;
			g[FP_DIMS]! += err;
		}
		for (let d = 0; d < FP_DIMS; d++) g[d]! += L2 * theta[d]!;
		const c1 = 1 - b1 ** step;
		const c2 = 1 - b2 ** step;
		for (let d = 0; d < n; d++) {
			m[d] = b1 * m[d]! + (1 - b1) * g[d]!;
			v[d] = b2 * v[d]! + (1 - b2) * g[d]! * g[d]!;
			theta[d]! -= (LEARNING_RATE * (m[d]! / c1)) / (Math.sqrt(v[d]! / c2) + 1e-8);
		}
	}

	// w·(x − μ) + b = w·x + (b − w·μ)
	const w = Float32Array.from(theta.subarray(0, FP_DIMS));
	let b = theta[FP_DIMS]!;
	for (let d = 0; d < FP_DIMS; d++) b -= theta[d]! * mu[d]!;
	return { w, b };
}

/** 打分：x 可以是没归一化的 int8 向量（这里一起算长度）。全零向量返回 0。 */
export function score(c: Classifier, x: ArrayLike<number>): number {
	let dotWX = 0;
	let norm = 0;
	for (let d = 0; d < FP_DIMS; d++) {
		const xd = x[d]!;
		dotWX += c.w[d]! * xd;
		norm += xd * xd;
	}
	if (!(norm > 0)) return 0;
	return sigmoid(dotWX / Math.sqrt(norm) + c.b);
}

/** 存进 D1：513 个 float32（最后一个是偏置）。 */
export function encodeClassifier(c: Classifier): Uint8Array {
	const out = new Float32Array(FP_DIMS + 1);
	out.set(c.w);
	out[FP_DIMS] = c.b;
	return new Uint8Array(out.buffer);
}

/** 也接受线上 D1 把 Uint8Array 存成的逗号分隔文本（见 similar.ts 的 blobOf()）。 */
export function decodeClassifier(blob: ArrayBuffer | Uint8Array | number[] | string): Classifier | null {
	const bytes =
		typeof blob === "string"
			? Uint8Array.from(blob.split(","), Number)
			: Array.isArray(blob)
				? Uint8Array.from(blob)
				: blob instanceof Uint8Array
					? blob.slice()
					: new Uint8Array(blob);
	if (bytes.byteLength !== (FP_DIMS + 1) * 4) return null;
	const f = new Float32Array(bytes.buffer, 0, FP_DIMS + 1);
	return { w: f.slice(0, FP_DIMS), b: f[FP_DIMS]! };
}
