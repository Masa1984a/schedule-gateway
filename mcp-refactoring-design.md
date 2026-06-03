# schedule-gateway DBアクセスのMCP化 — 設計・作業指示書

> **このドキュメントの目的**
> 既存プロジェクト `schedule-gateway` の「予定DB（Neon インスタンス A）へのアクセス方式」を、現状の **bootstrap（`~/.neonrc` への接続文字列注入）** から **MCPサーバ方式** へリファクタリングするための設計指針と作業指示。
>
> **このドキュメントの前提・限界**
> - 本書は設計対話の結果をまとめたもので、**実際のソースコードは確認していない**。
> - したがって「現状こうなっているはず」という記述には推測が含まれる。**`【要調査】` タグが付いた箇所は、作業開始前に実コードを読んで検証すること**。
> - 設計判断の背景は既存の `docs/design-spec.md`（特に §5〜§9）を必ず参照すること。本書はそれを補完する。

---

## 0. ゴールと非ゴール

### ゴール
- 予定DB（speaking_events / travel_routes）へのアクセスを、サンドボックス内 bash + `~/.neonrc` から、**Vercel上に立てたMCPサーバ経由**に置き換える。
- **DB接続文字列をサンドボックス（およびイベントログ）に一切露出させない**こと。これが本リファクタリングの最大の目的。
- 既存の3層疎結合アーキテクチャ（Android → Gateway → Agent）を壊さないこと。

### 非ゴール
- フロントエンド（PWA / `app/page.tsx`）の変更は原則不要。
- セッション台帳（gateway_sessions / インスタンス B）の仕組みは現状維持。これは引き続きGatewayが直接SQLで扱う。
- マルチユーザー化は対象外（別タスク）。

### この設計を採用する理由（背景）
現状の bootstrap 方式には次のトレードオフがある（`design-spec.md` §7.3）:
- `DATABASE_URL` がセッションのイベントログ（Anthropicサーバ側保存）に**平文で残る**。
- 露出軸は「`ANTHROPIC_API_KEY` にアクセスできる人」。

MCP化により、Agentが触れるのは「ツールの呼び出し（操作の意図と引数）」だけになり、SQL文も接続文字列もサーバ側に閉じ込められる。**プロンプトのお願い（「SQLはパラメータ化せよ」）を、構造的な保証に格上げする**のが狙い。

---

## 1. 設計の中核思想：3層への責務分離

処理を「**決定性**」と「**秘密への接触**」の2軸で3つに振り分ける。

| 層 | 担当する処理 | 決定性 | 秘密に触れる | 配置先 |
|---|---|---|---|---|
| **MCPツール（ワークフロー）** | 処理順序が固定 かつ DB絡み | 決定的 | ✅ する | Vercel上のMCPサーバ |
| **Skillsスクリプト** | DBに関連しない 決定的処理 | 決定的 | ❌ しない | 既存スキル内（現状維持） |
| **AI Agent** | 自然言語の解釈・ツール選択・文脈判断 | 非決定的 | ❌ しない | Anthropic側（変更不要） |

### 重要な運用原則：判断の単位は「機能」ではなく「ステップ」
1つのユーザー要求（例: 一括取込）は、上記3層をまたいで分解される。機能を丸ごとどこか1層に置くのではなく、**各ステップごとに「順序が固定か / 秘密に触れるか / 自然言語判断か」を問うて振り分ける**こと。

例（import-events 相当の要求）:
```
「来週の登壇リスト」テキスト入力
  ├─ 曖昧な日付の解釈（「来週あたり」）  → AI Agent
  ├─ テキストのパース・構造化           → Skillsスクリプト（DB非関連・決定的）
  ├─ 各予定のコンフリクト確認           → MCPツール（順序固定・DB絡み）
  └─ 登録                              → MCPツール（順序固定・DB絡み）
```

### MCPツールの粒度方針：副作用の有無で分ける
- **参照系（読み取りのみ・副作用なし）** → ツールを細かく分け、Agentに組み合わせさせてよい（漏れても被害が小さい）。
- **書き込み系（登録・更新・削除・副作用あり）** → 「コンフリクトチェック→書き込み」のような不変の手順を**1つのワークフローとしてツール内部に固める**（Agentの判断に委ねない）。

---

## 2. 【要調査】現状把握タスク（実装前に必ず実施）

本書は推測を含むため、着手前に以下を実コードで確認すること。

### 2-1. 既存のディレクトリ構成とコード
- [ ] `lib/anthropic.ts` の `bootstrapSession()` の実装を読む。`~/.neonrc` に何を、どう書いているか。【要調査】
- [ ] `lib/session.ts` の `getOrCreateSession()` の実装。セッション再利用ロジックの詳細。【要調査】
- [ ] `app/api/chat/route.ts` のSSE中継ロジック。stream-first / idle-gate の実装。【要調査】
- [ ] `scripts/reset-session.mjs` の挙動。MCP化後も保守スクリプトとして使えるか。【要調査】

### 2-2. `managed-agent/` フォルダ（Agent本体・5スキル）
> 📁 Agent定義と5スキルは、リポジトリ内の `managed-agent/` フォルダに配置されている。ここを確認すること。
- [ ] 5スキル（register-event / update-event / check-conflicts / import-events / manage-travel）の各 `SKILL.md` の手順を精読（`managed-agent/` 配下）。【要調査】
- [ ] 各スキルが `scripts/neon_client.sh` 経由で実行している**SQLの実体**を洗い出す。これがMCPツールの内部SQLになる。【要調査】
- [ ] `neon_client.sh`（`managed-agent/` 配下、各スキルに同梱）の関数（`neon_query` / `neon_rows` / `neon_scalar` / `neon_count`）の実装。【要調査】
- [ ] DB関数 `check_conflicts(start, end)` / `get_travel_time(...)` のシグネチャと戻り値。`managed-agent/` 内のセットアップ資材（DDLやマイグレーション）に定義がないか確認。【要調査】
- [ ] speaking_events / travel_routes の**正確なスキーマ**（カラム名・型・制約）。design-spec §6.3 に概要はあるが、`managed-agent/` 内の実DDLを確認すること。【要調査】

### 2-3. Managed Agents の最新仕様（時間が経過している可能性）
> Managed Agents は比較的新しい機能で、仕様が変わりうる。**公式ドキュメントで最新を確認すること**。
- [ ] **AgentにMCPサーバを紐づける方法**：`mcp_servers` フィールドの正確なスキーマ。Agent定義に書くのか、Session作成時に渡すのか。【要調査】公式: https://platform.claude.com/docs/en/managed-agents/
- [ ] **認証の渡し方**：MCPサーバにBearer/OAuthが必要な場合、Vault（`vault_ids`）経由でどう注入するか。Vaultは「MCPサーバURLにバインド」される仕様。【要調査】公式: https://platform.claude.com/docs/en/managed-agents/vaults
- [ ] **Streamable HTTP対応の確認**：Managed AgentsがリモートMCPに接続する際のトランスポート要件。現状 Streamable HTTP が推奨（SSEは非推奨）。【要調査】
- [ ] betaヘッダの最新版（現状 `managed-agents-2026-04-01`、SDKが自動付与）。バージョンが上がっていないか確認。【要調査】

### 2-4. Vercel MCPアダプタの最新仕様
- [ ] `mcp-handler` パッケージの最新APIを確認。本書のコード例は執筆時点のもので、API（`server.tool` vs `server.registerTool` 等）が変わっている可能性。【要調査】公式: https://github.com/vercel/mcp-handler
- [ ] `@modelcontextprotocol/sdk` は **1.26.0以降**を使う（それ未満は既知の脆弱性あり）。最新の推奨バージョンを確認。【要調査】
- [ ] Vercel Pro での **Fluid compute 有効化**手順と、`maxDuration` の上限（Pro/Enterpriseで800まで）。【要調査】

---

## 3. 目標アーキテクチャ

### 3-1. Before / After

```
【Before（現状: bootstrap）】
  Agent ──> サンドボックス内 bash ──> scripts/neon_client.sh ──> Neon(A)
                  ↑ ~/.neonrc に DATABASE_URL（平文・ログに残る）

【After（MCP化）】
  Agent ──(Streamable HTTP)──> schedule-gateway の /api/[transport] ──> Neon(A)
                                      ↑ DATABASE_URL はサーバ側 env に留まる
                                        サンドボックスにもログにも出ない
```

### 3-2. 配置の考え方
`schedule-gateway`（既存のNext.jsプロジェクト）に**MCPサーバ用のAPIルートを追加**する。別プロジェクトは立てない。
- 既存: `app/api/chat/route.ts`（Managed Agents中継）
- 追加: `app/api/[transport]/route.ts`（予定DBへのMCPサーバ）【パス名は要検討・下記参照】

結果として、Gateway自身が「Managed Agentsの中継」と「予定DBのMCPサーバ」を兼ねる。

> 【設計判断ポイント】MCPルートのパス
> `mcp-handler` の例では `app/api/[transport]/route.ts` という動的セグメントを使う。既存の `app/api/chat` や `app/api/health` と衝突しないか確認すること。衝突や可読性の懸念があれば `app/api/mcp/[transport]/route.ts` のようにネストする案も検討。【要調査】

---

## 4. 実装タスク

### 4-1. MCPサーバの雛形を追加
`mcp-handler` を導入し、APIルートを作成する。

```bash
npm install mcp-handler @modelcontextprotocol/sdk zod
# ↑ sdk は 1.26.0 以降であることを確認すること【要調査】
```

雛形（**最新APIは要確認**。`server.tool` の引数順・`registerTool` への変更などをドキュメントで検証）:

```ts
// app/api/[transport]/route.ts （パスは §3-2 の判断に従う）
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const handler = createMcpHandler(
  (server) => {
    // ここに §5 のツール群を登録する
  },
  {},
  {
    basePath: "/api",       // [transport] の位置に合わせる
    maxDuration: 800,       // Vercel Pro + Fluid compute 前提【要調査】
    verboseLogs: true,
  }
);

export { handler as GET, handler as POST, handler as DELETE };
```

### 4-2. DB接続ユーティリティ
- 既存の `@neondatabase/serverless`（design-spec の技術スタックに記載）を使い、`process.env.DATABASE_URL`（予定DB = インスタンスA）に接続する関数を用意する。
- **重要**: 接続文字列はサーバ側 env からのみ読む。クライアントや引数に出さない。
- 既存の `lib/` にDB接続のヘルパがあるか確認し、あれば再利用する。【要調査】

### 4-3. ツールの実装（§5 の定義に従う）
- 各スキルのSQL（§2-2 で洗い出したもの）を、TypeScriptのMCPツール内部に**パラメータ化クエリ**として移植する。
- 文字列結合は禁止。プレースホルダ／タグ付きテンプレートを使う。

### 4-4. 認証（MCPサーバ側）
> 【要調査・設計判断】
> このMCPサーバは公開URLになる。誰でも叩ける状態を避けるため、何らかの認証を付けるか検討すること。
> - 選択肢A: 既存の `GATEWAY_TOKEN` と同様のBearer検証を流用（`lib/auth.ts` の `isAuthorized` を再利用できるか）。
> - 選択肢B: Managed AgentsのVault経由でトークンをMCPサーバに注入し、サーバ側で検証。
> - Managed Agents → MCPサーバ間の認証を、Vaultでどう扱うかは §2-3 の調査結果に依存する。

### 4-5. Agent側の設定変更（`managed-agent/` フォルダ）
> 📁 Agent定義・5スキルは `managed-agent/` 配下にある。ここを編集する。
- [ ] Agent定義（または Session作成時）に、追加したMCPサーバのURLを `mcp_servers` として登録する。【要調査：登録方法】
- [ ] 5スキルのうち、MCPツールに置き換わった処理を**スキルから削除またはMCP呼び出しに変更**する。
  - DBアクセス部分（`neon_client.sh` 経由のSQL）はMCPツールに移行。
  - DB非関連の決定的処理（テキストパース等）はスキル内に残す（§1の3層分離）。
- [ ] bootstrap（`~/.neonrc` 注入）が不要になる。`lib/anthropic.ts` の `bootstrapSession()` を削除または無効化できるか検討。【要調査：他に副作用がないか】

### 4-6. bootstrap撤去の影響確認
- [ ] `bootstrapSession()` を外すと、`getOrCreateSession()` のセッション新規作成フローが変わる。初回レイテンシ（現状65〜76秒）がどう変化するか測定。【要調査】
- [ ] `scripts/reset-session.mjs`（bootstrapやり直し用）の役割が変わる/不要になる可能性。【要調査】

---

## 5. MCPツール定義（ドラフト）

> ⚠️ これは設計対話に基づく**ドラフト**。実際のスキーマ・SQL・DB関数を §2-2 で確認の上、確定させること。
> ツール名・引数・内部SQLは実装前に実コードと突き合わせる。

### 参照系（副作用なし・細かく分割可）

| ツール名（案） | 役割 | 引数（案） | 内部SQL/関数（要確認） |
|---|---|---|---|
| `get_events` | 期間内の予定一覧取得 | `from`, `to`（または `days`） | `SELECT ... FROM speaking_events WHERE start_at BETWEEN ...`【要調査：実SQL】 |
| `check_conflicts` | 時間重複の確認 | `start_at`, `end_at` | DB関数 `check_conflicts(start, end)`【要調査：シグネチャ】 |
| `get_travel_time` | 都市間移動時間の取得 | `from_city`, `to_city`（要確認） | DB関数 `get_travel_time(...)`【要調査：引数】 |

### 書き込み系（副作用あり・ワークフローとして固める）

| ツール名（案） | 役割 | ワークフロー（内部で固定すべき手順） |
|---|---|---|
| `register_event` | 予定1件の登録 | ①コンフリクトチェック → ②（オフラインなら）移動要否判定 → ③登録。この順序をツール内部に固定。【要調査：現スキルの手順】 |
| `update_event` | 予定の更新・削除 | ①更新前コンフリクトチェック → ②移動ブロック連動更新 → ③更新/削除。【要調査】 |
| `manage_travel` | 移動ブロックの登録/更新/削除 | travel_routes の参照/追加を含む。【要調査：現スキルの手順】 |

> 【設計判断ポイント】コンフリクトチェックの埋め込み
> 「登録前に必ずコンフリクトチェック」を `register_event` 内部に埋め込む（安全・ツールが太る）か、Agentに `check_conflicts` → `register_event` の順で呼ばせる（柔軟・Agent依存）か。
> 本書の方針は**書き込み系は内部に固める**（前者）。ただし現スキルの `SKILL.md` の手順を確認し、整合させること。【要調査】

### import（一括取込）の扱い
> 一括取込は3層をまたぐ（§1参照）。
> - 曖昧な日付解釈・パース → Agent / Skillsスクリプト側に残す。
> - 各予定の確認・登録 → 上記の参照系・書き込み系ツールを**Agentがループで呼ぶ**形にできるか検討。
> - 専用の `import_events` ツールをMCP側に作るかは、パース結果の受け渡し方法次第。【要調査・設計判断】

---

## 6. 検証計画

実装後、以下を確認する（既存の design-spec §12 の検証項目に対応させる）。

- [ ] `GET /api/health` が従来通り動く（既存機能の非回帰）。
- [ ] 未認証/不正トークンでMCPルートが拒否される（認証を付けた場合）。
- [ ] MCP Inspector または Streamable HTTP クライアントでMCPサーバに接続し、各ツールが呼べる。
- [ ] Managed Agent経由で「直近2週間のスケジュールを出力して」が、MCPツール呼び出し（`get_events`）で完走する。
- [ ] 予定の登録が、コンフリクトチェック込みのワークフローで動作する。
- [ ] **DB接続文字列がイベントログ（`events.list()`）に現れないことを確認**（本リファクタリングの成否を分ける最重要項目）。
- [ ] 初回セッションのレイテンシ変化を測定（bootstrap撤去の効果）。
- [ ] 実機（Android PWA）で従来通り動作する。

---

## 7. ロールバック方針
- MCP化はAgent側のスキル変更を伴うため、**Agent定義のバージョンを切って**段階移行するのが安全。
- 問題があれば、Agentを旧バージョン（bootstrap前提のスキル構成）に戻せるようにしておく。
- Gateway側のMCPルート追加は、既存の `/api/chat` と独立しているため、ルートを無効化すれば旧構成に戻せるはず。【要調査：依存がないか】

---

## 8. 参考：関連ドキュメント
- 既存設計書: `docs/design-spec.md`（§5 ゲートウェイ詳細 / §6 Agent側 / §7 鍵管理の山場 / §9 DB分離）
- Managed Agents 公式: https://platform.claude.com/docs/en/managed-agents/
- Managed Agents Vaults: https://platform.claude.com/docs/en/managed-agents/vaults
- Vercel MCP Handler: https://github.com/vercel/mcp-handler
- Vercel MCPデプロイ手順: https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel
- MCPトランスポート仕様（Streamable HTTP）: MCP spec 2025-11-25

---

## 付録: 調査タスク一覧（チェックリスト集約）

実装前にまとめて潰すべき `【要調査】`:

**既存コード（schedule-gateway）**
- [ ] `lib/anthropic.ts` の `bootstrapSession()` 実装
- [ ] `lib/session.ts` の `getOrCreateSession()` 実装
- [ ] `app/api/chat/route.ts` のSSE中継詳細
- [ ] `lib/` にDB接続ヘルパがあるか
- [ ] `lib/auth.ts` の `isAuthorized` をMCP認証に流用できるか
- [ ] MCPルートのパスが既存ルートと衝突しないか

**managed-agent/ フォルダ（Agent・スキル）**
- [ ] 5スキルの `SKILL.md` 手順
- [ ] 各スキルが実行するSQLの実体
- [ ] `neon_client.sh` の各関数実装
- [ ] DB関数 `check_conflicts` / `get_travel_time` のシグネチャ
- [ ] speaking_events / travel_routes の実DDL（カラム・型・制約）

**Managed Agents 最新仕様**
- [ ] `mcp_servers` フィールドのスキーマ（Agent定義 or Session作成時）
- [ ] Vault経由のMCP認証注入方法
- [ ] Streamable HTTP接続の要件
- [ ] betaヘッダの最新版

**Vercel / mcp-handler 最新仕様**
- [ ] `mcp-handler` の最新API（`tool` vs `registerTool`）
- [ ] `@modelcontextprotocol/sdk` 推奨バージョン
- [ ] Fluid compute 有効化と `maxDuration` 上限

**移行の影響**
- [ ] bootstrap撤去後の初回レイテンシ
- [ ] `reset-session.mjs` の役割変化
- [ ] ロールバック時の依存関係
