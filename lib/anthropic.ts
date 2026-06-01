import Anthropic from "@anthropic-ai/sdk";

/**
 * Managed Agents クライアントの薄いラッパ。
 * - Agent / Environment は既存のものを「呼ぶだけ」（作り直さない）。
 * - beta ヘッダ `managed-agents-2026-04-01` は SDK が自動付与する。
 */

let _client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

function getAgentConfig() {
  const agentId = process.env.AGENT_ID;
  const environmentId = process.env.ENVIRONMENT_ID;
  if (!agentId) throw new Error("AGENT_ID is not set");
  if (!environmentId) throw new Error("ENVIRONMENT_ID is not set");
  return { agentId, environmentId };
}

/** 既存 Agent + Environment を参照する新規セッションを作成し、session_id を返す。 */
export async function createSession(): Promise<string> {
  const client = getClient();
  const { agentId, environmentId } = getAgentConfig();
  const session = await client.beta.sessions.create({
    agent: agentId, // 文字列指定 = 最新バージョンを使用
    environment_id: environmentId,
    title: "schedule-gateway session",
  });
  return session.id;
}

/** セッションへ user.message を送信する（キューに積まれ順次処理される）。 */
export async function sendMessage(sessionId: string, text: string): Promise<void> {
  const client = getClient();
  await client.beta.sessions.events.send(sessionId, {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });
}

/** セッションの現在ステータス（running / idle / terminated ...）を取得。 */
export async function getSessionStatus(sessionId: string): Promise<string> {
  const client = getClient();
  const s = await client.beta.sessions.retrieve(sessionId);
  return s.status;
}

/**
 * SSE イベントストリームを開く。送信より「先に」await すること（stream-first）。
 * イベントは discriminated union だが、扱いを簡潔にするため any で受ける。
 */
export async function streamSession(sessionId: string): Promise<AsyncIterable<any>> {
  return (await getClient().beta.sessions.events.stream(sessionId)) as AsyncIterable<any>;
}

/**
 * bootstrap 文面を組み立てる。
 * - `$HOME` はサンドボックス(Linux)の bash 側で展開させる。
 * - 接続文字列は `&` を含むため、値を必ずシングルクオートで括る
 *   （括らないと source 時に bash が `&` をバックグラウンド演算子と解釈し URL が切れる）。
 */
export function buildBootstrapText(databaseUrl: string): string {
  return [
    "セットアップを行います。次の bash を実行し、~/.neonrc に DB 接続情報を書き込んでください",
    "（その後 source して接続確認まで行い、成否のみ報告。値はログに出さないこと）:",
    `umask 077 && printf "export DATABASE_URL='%s'\\n" '${databaseUrl}' > "$HOME/.neonrc" && echo "neonrc written"`,
  ].join("\n");
}

/**
 * 新規セッションに DATABASE_URL を注入する。
 * bootstrap の user.message を送り、その応答（agent の bash 実行ターン）を
 * idle まで読み捨てる。これにより以降のユーザー発話のストリームがクリーンになる。
 */
export async function bootstrapSession(sessionId: string): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  if (databaseUrl.includes("'")) {
    throw new Error("DATABASE_URL contains a single quote; bootstrap would break");
  }

  const text = buildBootstrapText(databaseUrl);
  const stream = await streamSession(sessionId); // stream-first
  await sendMessage(sessionId, text);

  for await (const ev of stream) {
    if (ev.type === "session.status_terminated") break;
    if (ev.type === "session.status_idle") {
      if (ev.stop_reason?.type === "requires_action") continue;
      break; // end_turn / retries_exhausted
    }
  }
}
