import { askAgentText, streamAgentEvents } from "@/lib/gateway-chat";
import { isAuthorized, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // Vercel Pro: Agent のツール実行は数十秒かかるため確保

// 個人運用は固定キー。複数ユーザー化する場合はトークン→user_key を導出する。
const USER_KEY = "me";

/**
 * POST /api/chat
 *   body : { "message": "..." }
 *   既定 : SSE ストリーム（PWA が逐次表示）
 *   ?mode=sync : idle まで待って最終テキストのみ JSON で返す（自動化向け）
 */
export async function POST(req: Request) {
  if (!isAuthorized(req)) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const message =
    typeof (body as { message?: unknown })?.message === "string"
      ? (body as { message: string }).message.trim()
      : "";
  if (!message) return json({ error: "message is required" }, 400);

  const sync = new URL(req.url).searchParams.get("mode") === "sync";

  if (sync) {
    try {
      const result = await askAgentText(USER_KEY, message);
      return json({ text: result.text, session_id: result.sessionId });
    } catch (err) {
      return json({ error: errMsg(err) }, 500);
    }
  }

  return sseResponse(USER_KEY, message);
}

/** SSE ストリームで agent の出力を中継する。 */
function sseResponse(userKey: string, message: string): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      try {
        for await (const ev of streamAgentEvents(userKey, message)) {
          switch (ev.type) {
            case "session":
              send("session", { session_id: ev.sessionId });
              break;
            case "message":
              send("message", { text: ev.text });
              break;
            case "tool":
              // 進捗フィードバック（「○○を実行中…」表示用）
              send("tool", { name: ev.name });
              break;
            case "done":
              send("done", { reason: ev.reason });
              controller.close();
              return;
          }
        }

        send("done", {});
        controller.close();
      } catch (err) {
        send("error", { message: errMsg(err) });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
