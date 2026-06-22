import { getOrCreateSession } from "@/lib/session";
import { streamSession, sendMessage } from "@/lib/anthropic";

export interface AgentTextResult {
  text: string;
  sessionId: string;
}

export type AgentStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "message"; text: string }
  | { type: "tool"; name: string }
  | { type: "done"; reason?: string };

/**
 * userKey に紐づく Managed Agent セッションへ message を送り、idle までの最終テキストを返す。
 * Web/PWA 以外の入口（Discord 等）でも同じ gateway → Managed Agent 経路を再利用するための共通関数。
 */
export async function askAgentText(userKey: string, message: string): Promise<AgentTextResult> {
  const sessionId = await getOrCreateSession(userKey);
  const text = await collectFinalText(sessionId, message);
  return { text, sessionId };
}

/**
 * userKey に紐づく Managed Agent セッションへ message を送り、イベントを逐次 yield する。
 * /api/chat の SSE 中継で利用する。
 */
export async function* streamAgentEvents(userKey: string, message: string): AsyncGenerator<AgentStreamEvent> {
  const sessionId = await getOrCreateSession(userKey);
  yield { type: "session", sessionId };

  const events = await streamSession(sessionId); // stream-first
  await sendMessage(sessionId, message);

  for await (const ev of events) {
    switch (ev.type) {
      case "agent.message":
        for (const block of ev.content ?? []) {
          if (block.type === "text" && block.text) {
            yield { type: "message", text: block.text };
          }
        }
        break;
      case "agent.tool_use":
        yield { type: "tool", name: ev.tool_name ?? ev.name ?? "tool" };
        break;
      case "session.status_terminated":
        yield { type: "done", reason: "terminated" };
        return;
      case "session.status_idle":
        if (ev.stop_reason?.type === "requires_action") continue;
        yield { type: "done", reason: ev.stop_reason?.type ?? "end_turn" };
        return;
    }
  }

  yield { type: "done" };
}

/** idle まで読み切り、agent のテキスト出力を結合して返す（sync/Discord 向け）。 */
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
