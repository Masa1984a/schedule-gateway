import { neon } from "@neondatabase/serverless";
import { createSession, bootstrapSession, getSessionStatus, getAgentId } from "./anthropic";

/**
 * VAULT_ID が設定されていれば MCP 方式（bootstrap 不要）。
 * セッション作成時に vault_ids を渡し、Agent 側の mcp_servers が予定DBへアクセスする。
 * 未設定の場合は旧 bootstrap 方式にフォールバックする（ロールバック時に利用）。
 */
function isMcpEnabled(): boolean {
  return !!process.env.VAULT_ID;
}

/**
 * user_key ↔ session_id を Neon に保存・再利用する。
 * 個人運用は user_key='me' 固定。terminated になっていたら作り直す。
 *
 * これがゲートウェイ唯一の直接 SQL（README §1 の例外）。
 * 予定データ本体には触れず、セッション状態の小テーブルだけを扱う。
 *
 * 接続先は SESSION_DATABASE_URL（gateway_sessions 専用インスタンス）。
 * 予定データの DATABASE_URL（bootstrap でサンドボックスに注入）とは別物。
 */

function db() {
  const url = process.env.SESSION_DATABASE_URL;
  if (!url) throw new Error("SESSION_DATABASE_URL is not set");
  return neon(url);
}

let tableEnsured = false;
async function ensureTable(): Promise<void> {
  if (tableEnsured) return;
  const sql = db();
  await sql`
    CREATE TABLE IF NOT EXISTS gateway_sessions (
      user_key     text PRIMARY KEY,
      session_id   text NOT NULL,
      agent_id     text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  // 既存テーブル（agent_id 列が無い旧スキーマ）へのマイグレーション。
  await sql`ALTER TABLE gateway_sessions ADD COLUMN IF NOT EXISTS agent_id text`;
  tableEnsured = true;
}

async function lookup(userKey: string): Promise<{ sessionId: string; agentId: string | null } | null> {
  const sql = db();
  const rows = (await sql`
    SELECT session_id, agent_id FROM gateway_sessions WHERE user_key = ${userKey}
  `) as Array<{ session_id: string; agent_id: string | null }>;
  const row = rows[0];
  return row ? { sessionId: row.session_id, agentId: row.agent_id } : null;
}

async function store(userKey: string, sessionId: string, agentId: string): Promise<void> {
  const sql = db();
  await sql`
    INSERT INTO gateway_sessions (user_key, session_id, agent_id, last_used_at)
    VALUES (${userKey}, ${sessionId}, ${agentId}, now())
    ON CONFLICT (user_key)
    DO UPDATE SET session_id = EXCLUDED.session_id,
                  agent_id   = EXCLUDED.agent_id,
                  last_used_at = now()
  `;
}

async function touch(userKey: string): Promise<void> {
  const sql = db();
  await sql`UPDATE gateway_sessions SET last_used_at = now() WHERE user_key = ${userKey}`;
}

// このステータスなら使い回せる。それ以外（terminated 等）は作り直す。
const REUSABLE = new Set(["running", "idle"]);

async function createAndBootstrap(userKey: string): Promise<string> {
  const sessionId = await createSession();
  // MCP 方式: bootstrap 不要（DATABASE_URL はサーバ側 env に留まる）
  // 旧 bootstrap 方式: MCP_SERVER_URL 未設定時のフォールバック
  if (!isMcpEnabled()) {
    await bootstrapSession(sessionId);
  }
  await store(userKey, sessionId, getAgentId());
  return sessionId;
}

/**
 * userKey のセッションを取得する。無い／終了済み／Agent世代不一致なら新規作成＋bootstrap。
 *
 * 台帳に保存した agent_id が現在の AGENT_ID と異なる場合は再利用しない。
 * これにより AGENT_ID を差し替えた直後は自動的に新しいセッションへ切り替わる
 * （旧スキーマ由来の agent_id=null も不一致扱いとなり、初回アクセスで作り直される）。
 */
export async function getOrCreateSession(userKey: string): Promise<string> {
  await ensureTable();

  const existing = await lookup(userKey);
  if (existing && existing.agentId === getAgentId()) {
    let status: string | null = null;
    try {
      status = await getSessionStatus(existing.sessionId);
    } catch {
      status = null; // 見つからない／取得失敗 → 作り直す
    }
    if (status && REUSABLE.has(status)) {
      await touch(userKey);
      return existing.sessionId;
    }
  }

  return createAndBootstrap(userKey);
}
