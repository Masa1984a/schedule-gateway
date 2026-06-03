# Managed Agents 移行キット

このディレクトリは、ローカルの Claude Code スキル（`.claude/skills/*`）を
**Claude Managed Agents** で実行できるようにするためのスクリプト群です。

## 全体像

Managed Agents は 4 概念で構成されます。

| 概念 | このプロジェクトでの中身 |
|---|---|
| **Agent** | model + system + tools(`agent_toolset_20260401`) + skills(5つ) |
| **Environment** | cloud サンドボックス + `networking: unrestricted`（Neon の HTTPS に出るため必須） |
| **Session** | 実行インスタンス。ここに発話（events）を送る |
| **Events** | `user.message` を送り、SSE で結果を受ける |

DB アクセスは従来どおり各スキル同梱の `scripts/neon_client.sh`（Neon HTTP `/sql`）経由。
サンドボックスには `curl`/`python` が標準で入っており、`unrestricted` ネットワークで Neon に到達できます。

## セットアップ手順

```powershell
# 0) 前提: API キーを環境変数に
$env:ANTHROPIC_API_KEY = "sk-ant-..."

# 1) 配布バンドルを生成（dist/<skill>/ と <skill>.zip）
.\build-skills.ps1

# 2) Skills API にアップロード（skill-ids.json を生成）
.\upload-skills.ps1
#   既存スキルを更新する場合:  .\upload-skills.ps1 -NewVersion

# 3) Agent / Environment / Session を作成し DATABASE_URL を注入
.\setup-agent.ps1
#   → agent-ids.json に各 ID を保存
```

`setup-agent.ps1` の最後に、SSE 購読と発話送信のサンプルコマンドが表示されます。

## スキルの改変点（ローカル版との差分）

`build-skills.ps1` は SKILL.md の bootstrap 1 行だけを書き換えます。
他の手順・SQL は一切変更しません。ローカルの `.claude/skills` は無改変です。

```diff
- set -a && source .env && set +a
+ set -a && . "$HOME/.neonrc" && set +a   # Managed Agents: DATABASE_URL を ~/.neonrc から読込
  source scripts/neon_client.sh
```

`neon_client.sh` は各スキルバンドルの `scripts/` に同梱されます（5 スキルに複製）。

## ⚠ DATABASE_URL の渡し方について（重要な設計判断）

公式ドキュメントを確認した結果、**Agent 定義・Environment 定義のいずれにも
「環境変数／シークレットを直接渡すフィールド」は存在しません**。

- Agent 受付フィールド: `name / model / system / tools / mcp_servers / skills / multiagent / description / metadata`
- Environment(cloud) config: `type / packages / networking`
- `vault_ids` は **MCP の OAuth/bearer 専用**（bash 用の汎用 env var ではない）

そこで本キットは、**セッション開始直後の bootstrap イベント**で
`~/.neonrc` に `export DATABASE_URL=...` を書き込み、各スキルがそれを読む方式を採用しています。

**トレードオフ**: DATABASE_URL がセッションのイベントログ（サーバ側保存）に残ります。
個人用ツールでは許容範囲ですが、本番運用では以下の代替を検討してください。

- **Vault + egress-proxy**: 認証情報をサンドボックスに見せず、送信時にプロキシで注入する方式
- **DB アクセスの MCP サーバ化**: `neon_client.sh` の各操作を MCP ツール化し、
  認証は MCP 側 / Vault に集約する（bash での SQL 組み立ても不要になり堅牢）

## ファイル

| ファイル | 役割 |
|---|---|
| `build-skills.ps1`  | SKILL.md 変換 + neon_client.sh 同梱 + zip 化 → `dist/` |
| `upload-skills.ps1` | `POST /v1/skills`（beta: `skills-2025-10-02`）→ `skill-ids.json` |
| `setup-agent.ps1`   | Agent/Environment/Session 作成 + DATABASE_URL 注入 → `agent-ids.json` |
| `dist/`             | 生成物（バンドルと zip）。コミット不要 |
| `skill-ids.json`    | スキル名 → skill_id |
| `agent-ids.json`    | agent/environment/session の ID |

## 注意 / ハマりどころ（実際に踏んだもの）

- **ベータヘッダの取り違えに注意**: Skills API は `skills-2025-10-02`、
  Agents/Sessions/Environments は `managed-agents-2026-04-01`。**別物**。
- **`display_title` はワークスペース内で一意制約**。重複すると
  `invalid_request_error: Skill cannot reuse an existing display_title`。
  再アップロードは upload-skills.ps1 の skip 機構（skill-ids.json 照合）で回避する。
- **curl レスポンスの文字化け**: curl の stdout を PowerShell 変数に取り込むと
  コンソール出力エンコーディングで復号され、日本語 `display_title` を含む JSON が壊れる。
  → `-o` で一時ファイルに受けて `Get-Content -Raw -Encoding utf8` で読む（対応済み）。
- **bootstrap の `$HOME`**: サンドボックスは Linux（`$HOME=/root`）。PowerShell here-string で
  bash の `$HOME` を渡すには backtick でエスケープ（`` `$HOME ``）。`\$HOME` は誤り
  （PowerShell の `$HOME`=Windows パスに展開され不正パスになる）。
- **接続文字列の `&` クォート**: Neon の URL は `...&sslmode=require` を含む。`~/.neonrc` に
  書く際は値を `' '` で括ること。括らないと source 時に bash が `&` をバックグラウンド
  演算子と解釈し、`DATABASE_URL` が途中で切れる。
- スキルは 1 セッションあたり最大 20。本プロジェクトは 5 なので余裕あり。
- スキルのアップロード合計サイズ上限は 30MB。
- **サンドボックスはセッション毎に独立・揮発**。`~/.neonrc` は新セッションごとに
  bootstrap で書き直される（setup-agent.ps1 が毎回送信）。
