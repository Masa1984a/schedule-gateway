import { askAgentText } from "@/lib/gateway-chat";
import { buildDiscordThreadKey, formatDiscordContent } from "@/lib/discord";
import { isAuthorized, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // Agent のツール実行に時間がかかるため確保

/**
 * POST /api/discord/message
 *
 * 常駐 Discord Gateway Bot（scripts/discord-bot.mjs）専用の内部エンドポイント。
 * フォーラムスレッドへの「普通の投稿」を受けて、同じ gateway → Managed Agent 経路で処理する。
 *
 * 認証: Authorization: Bearer <GATEWAY_TOKEN>（Bot プロセスが付与する）。
 *
 * body: { guild_id?: string, channel_id: string, message: string }
 *   channel_id … フォーラム投稿スレッドの ID。これを user_key 化してセッションを分離する。
 *
 * 返り値: { text: string, session_id: string }
 *
 * これにより:
 *   - 同じスレッドの会話 → 同じ user_key → 同じセッション再利用（継続）
 *   - 別スレッドの会話   → 別 user_key → 別セッション（独立）
 *   - 既存 Web/PWA 経路（user_key="me"）とも完全に独立
 */
export async function POST(req: Request) {
  if (!isAuthorized(req)) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const channelId = strField(body, "channel_id");
  const guildId = strField(body, "guild_id");
  const message = strField(body, "message");

  if (!channelId) return json({ error: "channel_id is required" }, 400);
  if (!message) return json({ error: "message is required" }, 400);

  try {
    const userKey = buildDiscordThreadKey(guildId || undefined, channelId);
    const result = await askAgentText(userKey, message);
    return json({ text: formatDiscordContent(result.text), session_id: result.sessionId });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

function strField(body: unknown, key: string): string {
  const v = (body as Record<string, unknown>)?.[key];
  return typeof v === "string" ? v.trim() : "";
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
