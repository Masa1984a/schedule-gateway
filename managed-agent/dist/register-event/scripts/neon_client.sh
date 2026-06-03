#!/bin/bash
# Neon HTTP SQL client (Serverless Driver compatible)
# 使い方: source scripts/neon_client.sh
#
# Neon の /sql HTTP エンドポイントに POST して SQL を実行する。
# 認証は接続文字列を Neon-Connection-String ヘッダーで渡すだけ。
# JSON 組み立て / 抽出は Python を利用 (jq 非依存)。
#
# 関数:
#   neon_query "<SQL>" [param1 param2 ...]
#       → 生レスポンス JSON ({command, fields, rows, rowCount}) を stdout に
#   neon_rows "<SQL>" [param1 ...]
#       → rows 配列のみ JSON で返す
#   neon_scalar "<col>" "<SQL>" [param1 ...]
#       → 1行目の指定カラムをプレーンテキストで返す
#   neon_count "<SQL>" [param1 ...]
#       → rowCount を返す
#   neon_query_file <body.json>
#       → 事前に書き出した JSON ボディ (query, params) を送信
#
# 例:
#   source scripts/neon_client.sh
#   neon_rows 'SELECT id, title FROM speaking_events WHERE start_at >= $1 ORDER BY start_at' '2026-04-01'
#   neon_rows 'SELECT * FROM check_conflicts($1, $2)' '2026-04-09T11:30:00+09:00' '2026-04-09T13:30:00+09:00'

set -o pipefail

: "${DATABASE_URL:?環境変数 DATABASE_URL が未設定です (Neon の postgresql://... 接続文字列)}"

# DATABASE_URL からホスト名のみ抽出
NEON_HOST="$(printf '%s' "$DATABASE_URL" | sed -E 's|^postgres(ql)?://[^@]+@([^/?]+).*|\2|')"
NEON_SQL_URL="https://${NEON_HOST}/sql"

# Python 検出 (python or python3)
if command -v python >/dev/null 2>&1; then
  NEON_PY=python
elif command -v python3 >/dev/null 2>&1; then
  NEON_PY=python3
else
  echo "neon_client.sh: python が見つかりません" >&2
  return 1 2>/dev/null || exit 1
fi

# 内部: SQL と params 配列から JSON ボディを組み立てて stdout へ
# 引数: $1=SQL, $2..=params
_neon_build_body() {
  NEON_SQL="$1"
  shift
  NEON_SQL="$NEON_SQL" "$NEON_PY" -c '
import json, os, sys
body = {"query": os.environ["NEON_SQL"], "params": sys.argv[1:]}
# ensure_ascii=True: 日本語等は \uXXXX にエスケープして送る
# (Windows + Git Bash + curl の経路で UTF-8 が壊れるのを回避)
sys.stdout.write(json.dumps(body, ensure_ascii=True))
' "$@"
}

# 内部: HTTP POST
_neon_post() {
  local body="$1"
  curl -sS -X POST "$NEON_SQL_URL" \
    -H "Neon-Connection-String: $DATABASE_URL" \
    -H "Content-Type: application/json" \
    --data-binary "$body"
}

# SQL 実行: 結果は { command, fields, rows, rowCount, ... } の JSON
neon_query() {
  local body
  body=$(_neon_build_body "$@")
  _neon_post "$body"
}

# rows 配列のみ JSON で返す
neon_rows() {
  neon_query "$@" | "$NEON_PY" -c '
import json, sys
data = json.load(sys.stdin)
if "rows" not in data:
    sys.stderr.write("neon error: " + json.dumps(data, ensure_ascii=False) + "\n")
    sys.exit(1)
print(json.dumps(data["rows"], ensure_ascii=False))
'
}

# 1 行目の特定カラムをスカラ取得
neon_scalar() {
  local col="$1"; shift
  export NEON_COL="$col"
  neon_query "$@" | "$NEON_PY" -c '
import json, os, sys
data = json.load(sys.stdin)
if "rows" not in data or not data["rows"]:
    sys.exit(0)
v = data["rows"][0].get(os.environ["NEON_COL"])
if v is None:
    sys.exit(0)
sys.stdout.write(str(v))
'
  unset NEON_COL
}

# rowCount 取得
neon_count() {
  neon_query "$@" | "$NEON_PY" -c '
import json, sys
data = json.load(sys.stdin)
print(data.get("rowCount", 0))
'
}

# 既製の JSON ボディファイルを送信
neon_query_file() {
  local body_file="$1"
  curl -sS -X POST "$NEON_SQL_URL" \
    -H "Neon-Connection-String: $DATABASE_URL" \
    -H "Content-Type: application/json" \
    --data-binary "@${body_file}"
}

# 接続テスト
neon_ping() {
  neon_scalar 'now' 'SELECT now() AS now'
}
