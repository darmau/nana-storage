import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * 纵深防御：Access 已经在边缘拦截了未登录请求，这里对每个请求再校验一次身份，
 * 防止 Access 应用配置失误（比如路径没覆盖、策略被改宽）时直接暴露数据。
 *
 * 规则：
 *  1. 平台注入的 ctx.access 可用时，要求 aud 与 ACCESS_AUD 一致，且邮箱是 OWNER_EMAIL。
 *  2. 否则自己验证 Cf-Access-Jwt-Assertion：签名（团队 JWKS）、iss、aud、exp，再比对邮箱。
 * 任何一步失败都返回 null，由调用方返回 403。没有任何“跳过鉴权”的开关。
 */

// JWKS 是公钥，缓存在模块作用域是安全的；jose 会处理轮换。
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksDomain: string | undefined;

function getJwks(teamDomain: string) {
	if (!jwks || jwksDomain !== teamDomain) {
		jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
		jwksDomain = teamDomain;
	}
	return jwks;
}

/** 规范成小写 origin（Access 签发的 iss 就是这个形式）；非 https 一律视为未配置。 */
function normalizeOrigin(value: string): string | null {
	try {
		const url = new URL(value);
		return url.protocol === "https:" ? url.origin : null;
	} catch {
		return null;
	}
}

const sameEmail = (a: unknown, b: string) =>
	typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();

interface AccessContext {
	aud?: string;
	getIdentity(): Promise<{ email?: string } | undefined | null>;
}

export async function authenticate(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<string | null> {
	const owner = env.OWNER_EMAIL;
	if (!owner || !env.ACCESS_AUD || owner.startsWith("REPLACE_")) return null;

	const access = (ctx as ExecutionContext & { access?: AccessContext }).access;
	if (access) {
		if (access.aud !== env.ACCESS_AUD) return null;
		const identity = await access.getIdentity().catch(() => null);
		return sameEmail(identity?.email, owner) ? owner : null;
	}

	const token = request.headers.get("cf-access-jwt-assertion");
	const teamDomain = normalizeOrigin(env.ACCESS_TEAM_DOMAIN);
	if (!token || !teamDomain) return null;
	try {
		const { payload } = await jwtVerify(token, getJwks(teamDomain), {
			issuer: teamDomain,
			audience: env.ACCESS_AUD,
			algorithms: ["RS256"],
		});
		return sameEmail(payload.email, owner) ? owner : null;
	} catch {
		return null;
	}
}
