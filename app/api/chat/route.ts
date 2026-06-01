import { getOrCreateSession } from "@/lib/session";
import { streamSession, sendMessage } from "@/lib/anthropic";
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

  let sessionId: string;
  try {
    sessionId = await getOrCreateSession(USER_KEY);
  } catch (err) {
    return json({ error: errMsg(err) }, 500);
  }

  if (sync) {
    try {
      const text = await collectFinalText(sessionId, message);
      return json({ text, session_id: sessionId });
    } catch (err) {
      return json({ error: errMsg(err) }, 500);
    }
  }

  return sseResponse(sessionId, message);
}

/** SSE ストリームで agent の出力を中継する。 */
function sseResponse(sessionId: string, message: string): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      try {
        send("session", { session_id: sessionId });

        const events = await streamSession(sessionId); // stream-first
        await sendMessage(sessionId, message);

        for await (const ev of events) {
          switch (ev.type) {
            case "agent.message":
              for (const block of ev.content ?? []) {
                if (block.type === "text" && block.text) {
                  send("message", { text: block.text });
                }
              }
              break;
            case "agent.tool_use":
              // 進捗フィードバック（「○○を実行中…」表示用）
              send("tool", { name: ev.tool_name ?? ev.name ?? "tool" });
              break;
            case "session.status_terminated":
              send("done", { reason: "terminated" });
              controller.close();
              return;
            case "session.status_idle":
              if (ev.stop_reason?.type === "requires_action") continue;
              send("done", { reason: ev.stop_reason?.type ?? "end_turn" });
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

/** idle まで読み切り、agent のテキスト出力を結合して返す（sync モード）。 */
async function collectFinalText(sessionId: string, message: string): Promise<string> {
  const events = await streamSession(sessionId); // stream-first
  await sendMessage(sessionId, message);

  let buf = "";
  for await (const ev of events) {
    if (ev.type === "agent.message") {
      for (const block of ev.content ?? []) {
        if (block.type === "text" && block.text) buf += block.text;
      }
    } else if (ev.type === "session.status_terminated") {
      break;
    } else if (ev.type === "session.status_idle") {
      if (ev.stop_reason?.type === "requires_action") continue;
      break;
    }
  }
  return buf.trim();
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
