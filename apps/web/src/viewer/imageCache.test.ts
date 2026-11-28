import { afterEach, describe, expect, it, vi } from "vitest";
import { isImageReady, preloadImage } from "./imageCache";

interface FakeImage {
	src: string;
	decoding: string;
	fetchPriority: string;
	decode: ReturnType<typeof vi.fn>;
}

function fakeImages(decode: () => Promise<void> = () => Promise.resolve()) {
	const images: FakeImage[] = [];
	vi.stubGlobal(
		"Image",
		class {
			src = "";
			decoding = "auto";
			fetchPriority = "auto";
			decode = vi.fn(decode);
			constructor() {
				images.push(this);
			}
		},
	);
	return images;
}

afterEach(() => vi.unstubAllGlobals());

describe("preview preloading", () => {
	it("deduplicates requests and decodes at low priority", async () => {
		const images = fakeImages();
		const url = "/api/a/dedupe/preview?v=1";
		preloadImage(url);
		preloadImage(url);
		expect(images).toHaveLength(1);
		expect(images[0]).toMatchObject({ src: url, decoding: "async", fetchPriority: "low" });
		expect(images[0]!.decode).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(isImageReady(url)).toBe(true));
		preloadImage(url);
		expect(images).toHaveLength(1);
	});

	it("allows a later retry after a failed preload", async () => {
		let reject!: (error: Error) => void;
		const images = fakeImages(() => new Promise<void>((_, r) => (reject = r)));
		const url = "/api/a/retry/preview?v=2";
		preloadImage(url);
		reject(new Error("network"));
		await vi.waitFor(() => expect(isImageReady(url)).toBe(false));
		preloadImage(url);
		expect(images).toHaveLength(2);
	});
});
