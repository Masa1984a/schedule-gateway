import { timingSafeEqual } from "node:crypto";

/**
 * `Authorization: Bearer <GATEWAY_TOKEN>` を検証する。
 * 長さ・内容ともにタイミングセーフに比較する。
 */
export function isAuthorized(req: Request): boolean {
  const expected = process.env.GATEWAY_TOKEN;
  if (!expected) return false; // 未設定なら常に拒否（fail-closed）

  const header = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;

  const token = header.slice(prefix.length).trim();
  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}
