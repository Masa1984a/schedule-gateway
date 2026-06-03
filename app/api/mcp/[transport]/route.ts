/**
 * MCPサーバ: 予定DB（speaking_events / travel_routes）への構造的アクセス層。
 *
 * DATABASE_URL をサーバ側環境変数に閉じ込め、Agent のサンドボックスやイベントログに
 * 接続文字列が一切漏れないようにする（bootstrap 方式からの移行目的）。
 *
 * ツール一覧:
 *   参照系: get_events / search_events / check_conflicts /
 *           get_travel_time / get_travel_routes / get_nearby_travel_blocks
 *   書込系: register_event / update_event / delete_event /
 *           import_events / upsert_travel_route
 *
 * 認証: Authorization: Bearer <GATEWAY_TOKEN> をすべてのリクエストで検証する。
 */

import { createMcpHandler } from "mcp-handler"
import { z } from "zod"
import { scheduleDb } from "@/lib/db"
import { isAuthorized, unauthorized } from "@/lib/auth"

export const runtime = "nodejs"
export const maxDuration = 800  // Vercel Pro + Fluid compute

// update_event で許可するフィールド名（SQL インジェクション対策のホワイトリスト）
const ALLOWED_UPDATE_FIELDS = new Set([
  "title", "start_at", "end_at", "location", "is_online",
  "category", "notes", "travel_from", "travel_to", "travel_mode",
])

// ツール呼び出し内で DB エラーをキャッチし、agent が読めるエラーメッセージを返す
function dbError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  return { isError: true as const, content: [{ type: "text" as const, text: `DB error: ${msg}` }] }
}

const mcpHandler = createMcpHandler(
  (server) => {
    // ── 参照系ツール（副作用なし） ────────────────────────────────────────

    server.tool(
      "get_events",
      "指定期間内のすべての予定（移動ブロック含む）を取得する。",
      {
        from: z.string().describe("開始日時（ISO 8601 例: 2026-04-01T00:00:00+09:00）"),
        to: z.string().describe("終了日時（ISO 8601 例: 2026-04-30T23:59:59+09:00）"),
      },
      async ({ from, to }) => {
        try {
          const { rows } = await scheduleDb().query(
            `SELECT id, title, start_at, end_at, location, is_online, category,
                    travel_from, travel_to, travel_mode, notes
             FROM speaking_events
             WHERE start_at >= $1 AND start_at <= $2
             ORDER BY start_at ASC`,
            [from, to],
          )
          return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] }
        } catch (e) { return dbError(e) }
      },
    )

    server.tool(
      "search_events",
      "タイトルを部分一致（ILIKE）で検索する。日付範囲でさらに絞り込める。",
      {
        query: z.string().describe("検索キーワード（例: 'Findy' / '札幌'）"),
        from: z.string().optional().describe("開始日時フィルタ（ISO 8601）"),
        to: z.string().optional().describe("終了日時フィルタ（ISO 8601）"),
      },
      async ({ query, from, to }) => {
        try {
          const db = scheduleDb()
          const pattern = `%${query}%`
          const { rows } = from && to
            ? await db.query(
                `SELECT id, title, start_at, end_at, location, category
                 FROM speaking_events
                 WHERE title ILIKE $1 AND start_at >= $2 AND start_at <= $3
                 ORDER BY start_at ASC`,
                [pattern, from, to],
              )
            : await db.query(
                `SELECT id, title, start_at, end_at, location, category
                 FROM speaking_events
                 WHERE title ILIKE $1
                 ORDER BY start_at ASC`,
                [pattern],
              )
          return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] }
        } catch (e) { return dbError(e) }
      },
    )

    server.tool(
      "check_conflicts",
      "指定時間帯と重複する予定を確認する。更新時は exclude_id で自身を除外できる。",
      {
        start_at: z.string().describe("開始日時（ISO 8601）"),
        end_at: z.string().describe("終了日時（ISO 8601）"),
        exclude_id: z.string().optional().describe("除外するイベント UUID（自身の更新時）"),
      },
      async ({ start_at, end_at, exclude_id }) => {
        try {
          const db = scheduleDb()
          const { rows } = exclude_id
            ? await db.query("SELECT * FROM check_conflicts($1, $2, $3::uuid)", [start_at, end_at, exclude_id])
            : await db.query("SELECT * FROM check_conflicts($1, $2)", [start_at, end_at])
          return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] }
        } catch (e) { return dbError(e) }
      },
    )

    server.tool(
      "get_travel_time",
      "travel_routes マスタから都市間の移動所要時間を取得する。mode 省略時は全候補を返す。",
      {
        from_city: z.string().describe("出発都市（例: 札幌市）"),
        to_city: z.string().describe("到着都市（例: 東京都）"),
        mode: z.string().optional().describe("移動手段（flight/train/car/bus）"),
      },
      async ({ from_city, to_city, mode }) => {
        try {
          const db = scheduleDb()
          const { rows } = mode
            ? await db.query("SELECT * FROM get_travel_time($1, $2, $3)", [from_city, to_city, mode])
            : await db.query("SELECT * FROM get_travel_time($1, $2)", [from_city, to_city])
          return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] }
        } catch (e) { return dbError(e) }
      },
    )

    server.tool(
      "get_travel_routes",
      "travel_routes マスタの全ルート一覧を取得する。",
      {},
      async () => {
        try {
          const { rows } = await scheduleDb().query(
            `SELECT from_city, to_city, mode, duration_minutes, notes
             FROM travel_routes
             ORDER BY from_city ASC, to_city ASC, mode ASC`,
          )
          return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] }
        } catch (e) { return dbError(e) }
      },
    )

    server.tool(
      "get_nearby_travel_blocks",
      "指定予定の前後 24 時間にある移動ブロック（category='travel'）を取得する。",
      {
        start_at: z.string().describe("基準開始日時（ISO 8601）"),
        end_at: z.string().describe("基準終了日時（ISO 8601）"),
        location: z.string().optional().describe("都市で絞り込む（travel_from または travel_to に一致）"),
      },
      async ({ start_at, end_at, location }) => {
        try {
          const { rows } = await scheduleDb().query(
            `SELECT id, title, start_at, end_at, travel_from, travel_to
             FROM speaking_events
             WHERE category = 'travel'
               AND start_at BETWEEN ($1::timestamptz - INTERVAL '24 hours')
                                AND ($2::timestamptz + INTERVAL '24 hours')
               AND ($3::text IS NULL OR travel_from = $3 OR travel_to = $3)
             ORDER BY start_at`,
            [start_at, end_at, location ?? null],
          )
          return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] }
        } catch (e) { return dbError(e) }
      },
    )

    // ── 書込系ツール ─────────────────────────────────────────────────────

    server.tool(
      "register_event",
      "予定を1件登録する。category='travel' の場合は移動ブロックとして登録する。登録前にユーザーの確認を取り、コンフリクトを check_conflicts で確認してから呼び出すこと。",
      {
        title: z.string().describe("タイトル"),
        start_at: z.string().describe("開始日時（ISO 8601 +09:00）"),
        end_at: z.string().describe("終了日時（ISO 8601 +09:00）"),
        location: z.string().describe("場所（移動ブロックは '移動中'）"),
        is_online: z.boolean().describe("オンライン開催かどうか"),
        category: z.string().describe("カテゴリ（speaking/lecture/social/internal/health/travel/other）"),
        notes: z.string().optional().describe("備考"),
        travel_from: z.string().optional().describe("移動元都市（category=travel のみ）"),
        travel_to: z.string().optional().describe("移動先都市（category=travel のみ）"),
        travel_mode: z.string().optional().describe("移動手段（flight/train/car/bus）"),
      },
      async ({ title, start_at, end_at, location, is_online, category, notes, travel_from, travel_to, travel_mode }) => {
        try {
          const { rows } = await scheduleDb().query(
            `INSERT INTO speaking_events
               (title, start_at, end_at, location, is_online, category, notes,
                travel_from, travel_to, travel_mode)
             VALUES ($1, $2, $3, $4, $5::boolean, $6, $7, $8, $9, $10)
             RETURNING id, title, start_at, end_at`,
            [
              title, start_at, end_at, location, String(is_online), category,
              notes ?? "", travel_from ?? null, travel_to ?? null, travel_mode ?? null,
            ],
          )
          return { content: [{ type: "text", text: JSON.stringify(rows[0], null, 2) }] }
        } catch (e) { return dbError(e) }
      },
    )

    server.tool(
      "update_event",
      "既存の予定を更新する。変更したいフィールドのみ指定する（id は必須）。日時変更時は事前に check_conflicts で確認すること。",
      {
        id: z.string().describe("更新するイベントの UUID"),
        title: z.string().optional(),
        start_at: z.string().optional(),
        end_at: z.string().optional(),
        location: z.string().optional(),
        is_online: z.boolean().optional(),
        category: z.string().optional(),
        notes: z.string().optional(),
        travel_from: z.string().optional(),
        travel_to: z.string().optional(),
        travel_mode: z.string().optional(),
      },
      async ({ id, ...fields }) => {
        try {
          const setClauses: string[] = []
          const params: unknown[] = []
          let i = 1

          for (const [key, value] of Object.entries(fields)) {
            if (value === undefined || !ALLOWED_UPDATE_FIELDS.has(key)) continue
            if (key === "is_online") {
              setClauses.push(`${key} = $${i++}::boolean`)
              params.push(String(value))
            } else {
              setClauses.push(`${key} = $${i++}`)
              params.push(value)
            }
          }

          if (setClauses.length === 0) {
            return { content: [{ type: "text", text: JSON.stringify({ error: "更新するフィールドを指定してください" }) }] }
          }

          params.push(id)
          const { rows } = await scheduleDb().query(
            `UPDATE speaking_events SET ${setClauses.join(", ")}
             WHERE id = $${i}::uuid
             RETURNING *`,
            params,
          )
          if (rows.length === 0) {
            return { content: [{ type: "text", text: JSON.stringify({ error: `id=${id} が見つかりません` }) }] }
          }
          return { content: [{ type: "text", text: JSON.stringify(rows[0], null, 2) }] }
        } catch (e) { return dbError(e) }
      },
    )

    server.tool(
      "delete_event",
      "予定を削除する（取り消し不可）。必ずユーザーの最終確認を取ってから呼び出すこと。",
      {
        id: z.string().describe("削除するイベントの UUID"),
      },
      async ({ id }) => {
        try {
          const { rows } = await scheduleDb().query(
            "DELETE FROM speaking_events WHERE id = $1::uuid RETURNING id, title",
            [id],
          )
          if (rows.length === 0) {
            return { content: [{ type: "text", text: JSON.stringify({ error: `id=${id} が見つかりません` }) }] }
          }
          return { content: [{ type: "text", text: JSON.stringify({ deleted: rows[0] }, null, 2) }] }
        } catch (e) { return dbError(e) }
      },
    )

    server.tool(
      "import_events",
      "予定を一括登録する。登録前にユーザーが内容を確認済みであること。",
      {
        events: z.array(z.object({
          title: z.string(),
          start_at: z.string(),
          end_at: z.string(),
          location: z.string(),
          is_online: z.boolean(),
          category: z.string(),
          notes: z.string().optional(),
        })).describe("登録する予定の配列。各要素は start_at < end_at であること。"),
      },
      async ({ events }) => {
        try {
          const normalized = events.map(e => ({ ...e, notes: e.notes ?? "" }))
          const { rows, rowCount } = await scheduleDb().query(
            `INSERT INTO speaking_events
               (title, start_at, end_at, location, is_online, category, notes)
             SELECT title, start_at::timestamptz, end_at::timestamptz,
                    location, is_online::boolean, category, notes
             FROM json_to_recordset($1::json) AS t(
               title TEXT, start_at TEXT, end_at TEXT,
               location TEXT, is_online BOOLEAN, category TEXT, notes TEXT
             )
             RETURNING id, title, start_at`,
            [JSON.stringify(normalized)],
          )
          return { content: [{ type: "text", text: JSON.stringify({ inserted: rowCount, events: rows }, null, 2) }] }
        } catch (e) { return dbError(e) }
      },
    )

    server.tool(
      "upsert_travel_route",
      "travel_routes マスタにルートを追加または更新する（from_city/to_city/mode の組み合わせで UPSERT）。",
      {
        from_city: z.string().describe("出発都市（例: 札幌市）"),
        to_city: z.string().describe("到着都市（例: 東京都）"),
        mode: z.string().describe("移動手段（flight/train/car/bus）"),
        duration_minutes: z.number().int().positive().describe("所要時間（分）"),
        notes: z.string().optional().describe("備考（例: 新千歳→羽田、空港アクセス含む）"),
      },
      async ({ from_city, to_city, mode, duration_minutes, notes }) => {
        try {
          const { rows } = await scheduleDb().query(
            `INSERT INTO travel_routes (from_city, to_city, mode, duration_minutes, notes)
             VALUES ($1, $2, $3, $4::int, $5)
             ON CONFLICT (from_city, to_city, mode) DO UPDATE
               SET duration_minutes = EXCLUDED.duration_minutes,
                   notes            = EXCLUDED.notes
             RETURNING *`,
            [from_city, to_city, mode, duration_minutes, notes ?? ""],
          )
          return { content: [{ type: "text", text: JSON.stringify(rows[0], null, 2) }] }
        } catch (e) { return dbError(e) }
      },
    )
  },
  { capabilities: { tools: {} } },
  {
    basePath: "/api/mcp",
    maxDuration: 800,
    verboseLogs: process.env.NODE_ENV !== "production",
  },
)

// MCP ハンドラに Bearer 認証を追加するラッパ
function withAuth(handler: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (!isAuthorized(req)) return unauthorized()
    return handler(req)
  }
}

export const GET = withAuth(mcpHandler)
export const POST = withAuth(mcpHandler)
export const DELETE = withAuth(mcpHandler)
