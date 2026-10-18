import { env } from "cloudflare:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { vi } from "vitest";

/** 一个“真的” Access：自己生成密钥，通过 mock 的 JWKS 提供公钥。测试里不允许任何真实外网请求。 */
export const TEAM = new URL(env.ACCESS_TEAM_DOMAIN).origin;
const keys = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };

export function mockAccessJwks() {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url === `${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
		throw new Error(`unexpected outbound fetch: ${url}`);
	});
}

export async function accessJwt(claims: Record<string, unknown> = {}, key: CryptoKey = keys.privateKey) {
	return new SignJWT({ email: "dev@localhost", ...claims })
		.setProtectedHeader({ alg: "RS256", kid: "test-key" })
		.setIssuer(TEAM)
		.setAudience((claims.aud as string) ?? "dev-aud")
		.setIssuedAt()
		.setExpirationTime((claims.exp as number) ?? "1h")
		.sign(key);
}

export async function authHeaders(extra: Record<string, string> = {}) {
	return { "cf-access-jwt-assertion": await accessJwt(), ...extra };
}
