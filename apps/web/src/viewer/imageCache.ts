/** 正在预加载的图片：保留引用，避免请求中途被回收；同一个地址不重复请求。 */
const preloading = new Map<string, HTMLImageElement>();

/**
 * 已经下载并解码过的预览地址。切换到这些照片时直接显示预览，不再先闪一下模糊的缩略图。
 * 最近几张的 Image 对象留着引用，浏览器更可能保留解码好的位图；只留几张，3840 的预览解码后每张几十 MB。
 */
const ready = new Map<string, HTMLImageElement | null>();
const READY_MAX = 200;
const DECODED_KEEP = 4;

export function markImageReady(url: string, img: HTMLImageElement | null) {
	ready.delete(url);
	ready.set(url, img);
	let held = 0;
	for (const [u, el] of [...ready].reverse()) {
		if (el && ++held > DECODED_KEEP) ready.set(u, null);
	}
	while (ready.size > READY_MAX) ready.delete(ready.keys().next().value!);
}

export const isImageReady = (url: string) => ready.has(url);

/** 低优先级提前下载并解码；打开查看器后，实际的 <img> 会把同一请求提升为高优先级。 */
export function preloadImage(url: string) {
	if (preloading.has(url) || ready.has(url)) return;
	const img = new Image();
	img.decoding = "async";
	img.fetchPriority = "low";
	preloading.set(url, img);
	img.src = url;
	// decode() 等下载完再在后台解码，切换过去时不用在主线程上现解一张大图
	img.decode().then(
		() => {
			preloading.delete(url);
			markImageReady(url, img);
		},
		() => preloading.delete(url),
	);
}
