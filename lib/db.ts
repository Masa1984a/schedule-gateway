/**
 * 予定DB（Neon インスタンス A）への HTTP クエリヘルパ。
 *
 * DATABASE_URL はサーバ側 env からのみ読む。クライアントや引数には一切出さない。
 * neon_client.sh と同等のことを TypeScript で実装したもの。
 * 値は常にパラメータ化（$1, $2, ...）して渡す。文字列結合禁止。
 */

export type DbRow = Record<string, unknown>

export interface DbResult<T = DbRow> {
  rows: T[]
  rowCount: number
}

export function scheduleDb() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is not set")

  // postgresql(s)://user:pass@host/db?... → host 部分だけ抽出
  const host = url.replace(/^postgres(?:ql)?:\/\/[^@]+@([^/?]+).*$/, "$1")
  const sqlEndpoint = `https://${host}/sql`

  return {
    async query<T = DbRow>(sql: string, params: unknown[] = []): Promise<DbResult<T>> {
      const res = await fetch(sqlEndpoint, {
        method: "POST",
        headers: {
          "Neon-Connection-String": url,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: sql, params }),
      })
      const data: { rows?: T[]; rowCount?: number; message?: string } = await res.json()
      if (!res.ok || data.message) {
        throw new Error(`DB error: ${data.message ?? `HTTP ${res.status}`}`)
      }
      return { rows: data.rows ?? [], rowCount: data.rowCount ?? 0 }
    },
  }
}
