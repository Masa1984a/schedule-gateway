import { resetSession } from "@/lib/session";
import { isAuthorized, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 個人運用は固定キー（/api/chat と揃える）。
const USER_KEY = "me";

/**
 * POST /api/session/reset
 *   セッション台帳の行を削除し、次回チャットで新規セッションを作り直させる。
 *   返り値: { reset: true, previous_session_id: string | null }
 */
export async function POST(req: Request) {
  if (!isAuthorized(req)) return unauthorized();

  try {
    const previous = await resetSession(USER_KEY);
    return json({ reset: true, previous_session_id: previous });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
