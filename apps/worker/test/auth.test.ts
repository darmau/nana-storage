import { SELF, env } from "cloudflare:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { authenticate } from "../src/auth";

const TEAM = new URL(env.ACCESS_TEAM_DOMAIN).origin;

// 一个“真的” Access：自己生成密钥，通过 mock 的 JWKS 提供公钥。
const keys = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
const otherKeys = await generateKeyPair("RS256");

async function accessJwt(claims: Record<string, unknown> = {}, key = keys.privateKey) {
	return new SignJWT({ email: "dev@localhost", ...claims })
		.setProtectedHeader({ alg: "RS256", kid: "test-key" })
		.setIssuer(TEAM)
		.setAudience((claims.aud as string) ?? "dev-aud")
		.setIssuedAt()
		.setExpirationTime((claims.exp as number) ?? "1h")
		.sign(key);
}

beforeAll(() => {
	const realFetch = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url === `${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
		// 测试里不允许任何真实的外网请求
		void realFetch;
		throw new Error(`unexpected outbound fetch: ${url}`);
	});
});

const ctxWith = (access?: unknown) =>
	({ waitUntil() {}, passThroughOnException() {}, access }) as unknown as ExecutionContext;
const req = (headers: Record<string, string> = {}) => new Request("http://example.com/api/me", { headers });

describe("authenticate()", () => {
	it("accepts the owner via ctx.access with matching aud", async () => {
		const ctx = ctxWith({ aud: "dev-aud", getIdentity: async () => ({ email: "Dev@Localhost" }) });
		expect(await authenticate(req(), env, ctx)).toBe("dev@localhost");
	});

	it("rejects a different email", async () => {
		const ctx = ctxWith({ aud: "dev-aud", getIdentity: async () => ({ email: "attacker@example.com" }) });
		expect(await authenticate(req(), env, ctx)).toBeNull();
	});

	it("rejects a wrong aud (another Access application)", async () => {
		const ctx = ctxWith({ aud: "other-app", getIdentity: async () => ({ email: "dev@localhost" }) });
		expect(await authenticate(req(), env, ctx)).toBeNull();
	});

	it("rejects when identity lookup fails", async () => {
		const ctx = ctxWith({ aud: "dev-aud", getIdentity: async () => { throw new Error("boom"); } });
		expect(await authenticate(req(), env, ctx)).toBeNull();
	});

	it("rejects requests without ctx.access or JWT", async () => {
		expect(await authenticate(req(), env, ctxWith())).toBeNull();
	});

	it("accepts a valid Access JWT for the owner", async () => {
		const token = await accessJwt();
		expect(await authenticate(req({ "cf-access-jwt-assertion": token }), env, ctxWith())).toBe("dev@localhost");
	});

	it("rejects a valid JWT for someone else", async () => {
		const token = await accessJwt({ email: "attacker@example.com" });
		expect(await authenticate(req({ "cf-access-jwt-assertion": token }), env, ctxWith())).toBeNull();
	});

	it("rejects a JWT for another Access application (aud)", async () => {
		const token = await accessJwt({ aud: "other-app" });
		expect(await authenticate(req({ "cf-access-jwt-assertion": token }), env, ctxWith())).toBeNull();
	});

	it("rejects an expired JWT", async () => {
		const token = await accessJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
		expect(await authenticate(req({ "cf-access-jwt-assertion": token }), env, ctxWith())).toBeNull();
	});

	it("rejects a JWT signed with a different key", async () => {
		const token = await accessJwt({}, otherKeys.privateKey);
		expect(await authenticate(req({ "cf-access-jwt-assertion": token }), env, ctxWith())).toBeNull();
	});

	it("rejects a forged JWT", async () => {
		const forged = [
			btoa(JSON.stringify({ alg: "RS256", typ: "JWT" })),
			btoa(JSON.stringify({ email: "dev@localhost", aud: "dev-aud", exp: 9999999999 })),
			"c2lnbmF0dXJl",
		].join(".");
		const e = { ...env, ACCESS_TEAM_DOMAIN: "https://unreachable.invalid" };
		expect(await authenticate(req({ "cf-access-jwt-assertion": forged }), e, ctxWith())).toBeNull();
	});

	it("rejects everything when the identity secrets are missing entirely", async () => {
		const ctx = ctxWith({ aud: "dev-aud", getIdentity: async () => ({ email: "dev@localhost" }) });
		for (const missing of ["OWNER_EMAIL", "ACCESS_AUD"] as const) {
			const e = { ...env, [missing]: undefined } as unknown as Env;
			expect(await authenticate(req(), e, ctx), missing).toBeNull();
		}
		const token = await accessJwt();
		const noTeam = { ...env, ACCESS_TEAM_DOMAIN: undefined } as unknown as Env;
		expect(await authenticate(req({ "cf-access-jwt-assertion": token }), noTeam, ctxWith())).toBeNull();
	});

	it("rejects everything while OWNER_EMAIL is unconfigured", async () => {
		const ctx = ctxWith({ aud: "dev-aud", getIdentity: async () => ({ email: "REPLACE_WITH_YOUR_EMAIL" }) });
		const e = { ...env, OWNER_EMAIL: "REPLACE_WITH_YOUR_EMAIL" };
		expect(await authenticate(req(), e, ctx)).toBeNull();
	});
});

describe("HTTP layer", () => {
	const auth = async (extra: Record<string, string> = {}) => ({
		"cf-access-jwt-assertion": await accessJwt(),
		...extra,
	});

	it("rejects unauthenticated requests to the API and to static assets", async () => {
		for (const path of ["/api/me", "/", "/index.html", "/api/guard"]) {
			const res = await SELF.fetch(`http://example.com${path}`);
			expect(res.status, path).toBe(403);
		}
	});

	it("serves the API to the owner with security headers", async () => {
		const res = await SELF.fetch("http://example.com/api/me", { headers: await auth() });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ email: "dev@localhost" });
		expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
		expect(res.headers.get("cache-control")).toMatch(/private|no-store/);
		expect(res.headers.get("x-frame-options")).toBe("DENY");
		expect(res.headers.get("vary")).toContain("Cookie");
	});

	it("puts security headers on static assets too", async () => {
		const res = await SELF.fetch("http://example.com/", { headers: await auth() });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
		expect(res.headers.get("cache-control")).toMatch(/private|no-store/);
	});

	it("lets the browser cache hashed bundles, but not index.html or SPA fallbacks", async () => {
		const index = await SELF.fetch("http://example.com/", { headers: await auth() });
		expect(index.headers.get("cache-control")).toBe("private, no-cache");
		expect(index.headers.get("vary")).toContain("Cookie");
		const script = (await index.text()).match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
		expect(script).toBeTruthy();
		const bundle = await SELF.fetch(`http://example.com${script}`, { headers: await auth() });
		expect(bundle.status).toBe(200);
		expect(bundle.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
		expect(bundle.headers.get("content-security-policy")).toContain("default-src 'self'");
		// Access 的 cookie 续期后长期缓存仍然有效
		expect(bundle.headers.get("vary") ?? "").not.toContain("Cookie");
		// 不存在的文件回退成 index.html，不能被长期缓存
		const missing = await SELF.fetch("http://example.com/assets/missing-AbCd1234.js", { headers: await auth() });
		expect(missing.headers.get("cache-control")).toBe("private, no-cache");
		expect((await SELF.fetch(`http://example.com${script}`)).status).toBe(403);
	});

	it("rejects mutations without the CSRF header", async () => {
		const res = await SELF.fetch("http://example.com/api/guard/resume", {
			method: "POST",
			headers: await auth({ Origin: "http://example.com" }),
		});
		expect(res.status).toBe(403);
	});

	it("rejects cross-origin mutations", async () => {
		const res = await SELF.fetch("http://example.com/api/guard/resume", {
			method: "POST",
			headers: await auth({ Origin: "https://evil.example", "X-Requested-With": "nana" }),
		});
		expect(res.status).toBe(403);
	});

	it("accepts same-origin mutations with the header", async () => {
		const res = await SELF.fetch("http://example.com/api/guard/resume", {
			method: "POST",
			headers: await auth({ Origin: "http://example.com", "X-Requested-With": "nana" }),
		});
		expect(res.status).toBe(200);
	});
});
