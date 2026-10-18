import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSite } from "../client.mjs";

test("site must be https, except local development hosts", () => {
	assert.equal(normalizeSite("https://photos.example.com/settings"), "https://photos.example.com");
	assert.equal(normalizeSite(" https://Photos.Example.com "), "https://photos.example.com");
	assert.equal(normalizeSite("http://photos.example.com"), null);
	assert.equal(normalizeSite("http://localhost:8787"), "http://localhost:8787");
	assert.equal(normalizeSite("http://host.docker.internal:8787"), "http://host.docker.internal:8787");
	assert.equal(normalizeSite("javascript:alert(1)"), null);
	assert.equal(normalizeSite(""), null);
});
