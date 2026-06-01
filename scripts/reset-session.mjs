// 一回限りの保守スクリプト: gateway_sessions の指定 user_key 行を削除し、
// 次回アクセスで新規セッション + bootstrap をやり直させる。
//   使い方: node scripts/reset-session.mjs [user_key]   (既定 'me')
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

function loadEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return out;
}

const env = loadEnv(new URL("../.env.local", import.meta.url));
const url = env.SESSION_DATABASE_URL;
if (!url) throw new Error("SESSION_DATABASE_URL not found in .env.local");
const userKey = process.argv[2] ?? "me";

const sql = neon(url);
const rows = await sql`DELETE FROM gateway_sessions WHERE user_key = ${userKey} RETURNING session_id`;
console.log(`deleted ${rows.length} row(s):`, rows.map((r) => r.session_id).join(", ") || "(none)");
