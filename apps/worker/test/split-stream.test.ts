import { describe, expect, it } from "vitest";
import { splitStream } from "../src/processor";

const streamOf = (...chunks: string[]) =>
	new ReadableStream<Uint8Array>({
		start(c) {
			for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
			c.close();
		},
	});
const text = async (s: ReadableStream<Uint8Array>) => new Response(s).text();

describe("splitStream", () => {
	it("splits inside a chunk, across chunks and on a chunk boundary", async () => {
		for (const chunks of [["{\"a\":1}IMAGEBYTES"], ["{\"a", "\":1", "}IMA", "GEBYTES"], ["{\"a\":1}", "IMAGE", "BYTES"]]) {
			const { head, rest } = await splitStream(streamOf(...chunks), 7);
			expect(new TextDecoder().decode(head)).toBe('{"a":1}');
			expect(await text(rest)).toBe("IMAGEBYTES");
		}
	});

	it("throws when the stream is shorter than the head", async () => {
		await expect(splitStream(streamOf("abc"), 7)).rejects.toThrow("stream ended early");
	});
});
