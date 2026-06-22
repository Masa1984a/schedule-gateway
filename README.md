# schedule-gateway

スマホ（Android）から、既存の **Claude Managed Agent（スケジュール管理エージェント）** を
使うための **ゲートウェイ + PWA** を、Vercel Pro 上に構築するプロジェクト。

- **ゲートウェイ**: APIキーを保持し、Managed Agents API へ中継する自前バックエンド
- **PWA**: スマホのホーム画面に追加して使うチャットUI（窓口）
- 両者を **1つの Next.js プロジェクト**に同居させ、1デプロイで運用する

> 関連: 頭脳側（Agent本体・5スキル）は別リポ `schedule`（`C:\mySkills\schedule`）で構築済み。
> 本プロジェクトはそれを「呼ぶだけ」。Agent/スキルのコードは含めない。

---

## 全体アーキテクチャ

```
[Androidスマホ]
   │  HTTPS（自分専用トークンで認証）
   ▼
[schedule-gateway @ Vercel Pro]            ← このプロジェクト
   ├─ PWA（チャットUI / ホーム画面追加）
   └─ API（ゲートウェイ）
        │  x-api-key（Vercel env varに保持）
        ▼
[Claude Managed Agents API @ Anthropic]    ← 呼ぶだけ
   └─ セッション（agent + 5スキル）→ サンドボックス → Neon
        ▲
[Neon (PostgreSQL)]  ← 予定データ本体 + ゲートウェイのセッション状態
```

ポイント:
- **APIキー・接続文字列はゲートウェイ（Vercel env）だけに置く**。スマホには絶対に置かない。
- **DB操作はAgent経由**。ゲートウェイ自身は基本SQLしない（例外: 後述のセッション状態テーブルのみ）。
- 実行時間が長い（Agentのツール実行で30〜60秒）→ **ストリーミング(SSE)** で進捗を返す。

---

## 1. 要件（Requirements）

### 1.1 アカウント / 前提
- **Vercel Pro**（契約済み）— 関数の `maxDuration` を延長可能（標準で最大300秒。Fluid computeでさらに延長可。最新上限はVercelダッシュボードで要確認）
- **Anthropic APIキー**（`ANTHROPIC_API_KEY`）
- **GitHub アカウント**（Vercel連携・自動デプロイ用）
- **Neon**（既存。`DATABASE_URL` を再利用）
- 既存 Agent の ID（`schedule/managed-agent/agent-ids.json` より）
  - `AGENT_ID` = `agent_01XtE3W37NR3jjDRSbTFc8eh`
  - `ENVIRONMENT_ID` = `env_01H8NkXMX3wsZCXx1hM9w1Hn`

### 1.2 技術スタック
- **Next.js（App Router）+ TypeScript**（API Routes と PWA を同居）
- `@anthropic-ai/sdk`（Managed Agents 呼び出し。betaヘッダは SDK が自動付与）
- `@neondatabase/serverless`（セッション状態の保存・任意）
- PWA: `manifest.webmanifest` + Service Worker（`next-pwa` か手書き）
- Node.js 20+（Vercel ランタイム）

### 1.3 環境変数（Vercel プロジェクトに設定）
| 変数 | 用途 | 例/出所 |
|---|---|---|
| `ANTHROPIC_API_KEY` | Managed Agents 呼び出し | Anthropic Console |
| `AGENT_ID` | 使用するAgent | agent-ids.json |
| `ENVIRONMENT_ID` | 使用するEnvironment | agent-ids.json |
| `DATABASE_URL` | 予定データDB（bootstrapでサンドボックスに注入）| 予定データ側 Neon |
| `SESSION_DATABASE_URL` | セッション台帳（`gateway_sessions`）| セッション側 Neon（別インスタンス）|
| `GATEWAY_TOKEN` | 自分専用の認証トークン | 自分で生成（長いランダム文字列） |
| `ANTHROPIC_BETA` | （任意）`managed-agents-2026-04-01` | 固定値 |

> ⚠ `.env.local` はローカル開発用。**コミット禁止**（`.gitignore` 済み）。本番値は Vercel の
> Environment Variables に登録する。

### 1.4 セキュリティ要件
- すべてのAPIは `Authorization: Bearer <GATEWAY_TOKEN>` を必須にする（未認証は401）。
- `DATABASE_URL` は **bootstrapイベントでサンドボックスに渡る＝イベントログに残る**点を許容
  （個人用途）。本番強化時は Vault / egress-proxy / MCP化を検討。
- PWAはHTTPSのみ（Vercelは標準HTTPS）。トークンは端末のlocalStorageに保存（個人端末前提）。

---

## 2. プロジェクト構成（予定）

```
schedule-gateway/
├─ app/
│  ├─ page.tsx                  # PWA チャットUI
│  ├─ layout.tsx
│  ├─ manifest.webmanifest      # PWA マニフェスト
│  └─ api/
│     ├─ chat/route.ts          # 発話送信 → Agent → SSEで返す（メイン）
│     └─ health/route.ts        # 死活確認
├─ lib/
│  ├─ anthropic.ts              # Managed Agents クライアント（session取得/送信/stream）
│  ├─ session.ts               # user_key↔session_id を Neon に保存・再利用 + bootstrap
│  └─ auth.ts                   # Bearer トークン検証
├─ public/
│  ├─ icon-192.png / icon-512.png   # PWA アイコン
│  └─ sw.js                     # Service Worker（オフライン枠/通知。最小でOK）
├─ .env.example
├─ .gitignore
├─ next.config.js
├─ package.json
└─ README.md
```

---

## 3. ゲートウェイ API 設計

### `POST /api/chat`（メイン）
- 認証: `Authorization: Bearer <GATEWAY_TOKEN>`
- リクエスト: `{ "message": "6/14 14:00 旭川高専でオンライン登壇を追加して" }`
- 処理:
  1. ユーザーの **session_id を取得**（無ければ Managed Agents で新規作成し、**bootstrap送信**）
  2. `POST /v1/sessions/{id}/events` に `user.message` を送信
  3. `GET /v1/sessions/{id}/stream`(SSE) を購読し、`agent.message` をクライアントへ中継
  4. `session.status_idle` で完了
- レスポンス: **SSEストリーム**（PWAが逐次表示）。Android自動化向けに `?mode=sync` で
  「idleまで待って最終テキストのみ返す」モードも用意可。

### セッション再利用（`lib/session.ts`）
- Neon に小テーブルを1つ用意:
  ```sql
  CREATE TABLE IF NOT EXISTS gateway_sessions (
    user_key    text PRIMARY KEY,
    session_id  text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now()
  );
  ```
- 個人運用は `user_key='me'` 固定でOK。`status` が `terminated` なら作り直す。
- **新規セッション時のbootstrap**（既存の修正版と同じ。`$HOME`はサンドボックスのLinux側、`&`対策で値をクォート）:
  ```
  umask 077 && printf "export DATABASE_URL='%s'\n" '<DATABASE_URL>' > "$HOME/.neonrc" && echo "neonrc written"
  ```

### Managed Agents 呼び出しメモ（`lib/anthropic.ts`）
- ベースURL `https://api.anthropic.com`、betaヘッダ `managed-agents-2026-04-01`（SDKは自動付与）
- 主要操作: `sessions.create` / `sessions.retrieve`(status確認) / `sessions.events.send` / `sessions.events.stream`
- 既存 `AGENT_ID` / `ENVIRONMENT_ID` を使う（Agentは作り直さない）

---

## 4. 構築手順（Step by Step）

### Step 0. 事前準備
- `GATEWAY_TOKEN` を生成（例: `openssl rand -hex 32` 相当の長い文字列）
- `schedule/managed-agent/agent-ids.json` の `agent_id` / `environment_id` を控える

### Step 1. プロジェクト初期化
```powershell
cd C:\mySkills\schedule-gateway
npx create-next-app@latest . --typescript --app --eslint --no-tailwind --no-src-dir
npm i @anthropic-ai/sdk @neondatabase/serverless
git init    # 別gitリポジトリにする
```

### Step 2. 環境変数（ローカル）
- `.env.example` を `.env.local` にコピーし、実値を設定（`.env.local` はコミットしない）

### Step 3. 実装
- `lib/auth.ts` → Bearer 検証
- `lib/anthropic.ts` → Managed Agents クライアント
- `lib/session.ts` → セッション取得/作成 + bootstrap
- `app/api/chat/route.ts` → 上記を束ねてSSE返却（`export const maxDuration = 300`）
- `app/page.tsx` → 最小チャットUI（入力欄＋ストリーム表示＋トークン保存）
- `manifest.webmanifest` / アイコン / `sw.js` → PWA化

### Step 4. ローカル動作確認
```powershell
npm run dev
# 別ターミナルから:
#   curl -N -X POST http://localhost:3000/api/chat `
#     -H "Authorization: Bearer <GATEWAY_TOKEN>" -H "content-type: application/json" `
#     -d '{"message":"登録済みの予定を確認して"}'
```

### Step 5. GitHub & Vercel デプロイ
1. GitHubに新規リポジトリを作成し push
2. Vercel → **Add New Project** → 当該リポをImport
3. **Environment Variables** に §1.3 の全変数を登録（Production/Preview）
4. Deploy → 払い出されたURL（例 `https://schedule-gateway.vercel.app`）を確認
5. 必要なら **maxDuration** をPro上限まで設定（関数ごとに `export const maxDuration`）

### Step 6. スマホ（Android）でPWA導入
1. Chromeで本番URLを開く → ログイン（`GATEWAY_TOKEN` を入力 → localStorage保存）
2. メニュー →「**ホーム画面に追加**」→ アプリのように起動
3. 「6/14 14:00 旭川高専でオンライン登壇を追加して」等で動作確認

### Step 7. （任意）窓口の追加
- 同じ `/api/chat` を叩く形で **LINE Bot** や **Android自動化（HTTP Shortcuts/Tasker）** を後付け可能。

---

## 5. 受け入れ基準（Done の定義）
- [ ] スマホのPWAから発話 → Agentが応答（ストリーム表示）
- [ ] 予定の登録/確認/移動ブロックがNeonに反映される（既存スキルが発火）
- [ ] 未認証リクエストが401で弾かれる
- [ ] セッションが使い回され、文脈が継続する
- [ ] APIキー・接続文字列がクライアント側に露出しない
- [ ] 新セッション時にbootstrapが自動実行され `~/.neonrc` が正しく書ける

---

## 6. 注意 / 既知の落とし穴（schedule リポでの学びを継承）
- **ベータヘッダ**: Managed Agents は `managed-agents-2026-04-01`（SDK自動付与）。Skills APIの
  `skills-2025-10-02` とは別物。
- **bootstrapの罠**: サンドボックスはLinux（`$HOME=/root`）。`$HOME` はbash側で展開。接続文字列の
  `&` 対策で **値を必ずクォート**（さもないと source 時にURLが途中で切れる）。
- **実行時間**: Agentのツール実行は数十秒。SSEで進捗を返し、`maxDuration` を確保する。
- **セッションの揮発**: サンドボックスはセッション毎に独立。`~/.neonrc` は新セッション毎に
  bootstrapで再注入される。

---

## 7. 次アクション
この要件でよければ、Step 1〜3 の **コード雛形を scaffold** する。
（`lib/anthropic.ts` / `lib/session.ts` / `app/api/chat/route.ts` / 最小PWA UI / `.env.example`）

---

## 8. Discord フォーラムチャネル連携

既存の **Web/PWA → `/api/chat` → gateway → Claude Managed Agent** の経路は残したまま、
Discord の slash command から同じ gateway 経路を呼べるようにしている。

```
[Discord Forum Channel]
   └─ Forum Post / Thread
        │  /schedule message:<本文>
        ▼
[/api/discord/interactions @ schedule-gateway]
        │  thread_id を user_key 化
        ▼
[gateway_sessions]
        │  user_key=discord:guild:<guild_id>:thread:<thread_id>
        ▼
[Claude Managed Agents API]
```

### 8.1 セッション分離のルール

- Web/PWA は従来どおり `user_key='me'` を使う。
- Discord は **フォーラム投稿スレッドの `channel_id`** を使って
  `user_key=discord:guild:<guild_id>:thread:<thread_id>` を作る。
- 同じスレッドで `/schedule` を繰り返すと同じ `session_id` が再利用され、会話文脈が継続する。
- 別スレッドでは `user_key` が変わるため、別の Managed Agent セッションが作られ、会話文脈は独立する。

### 8.2 Discord 側の設定

1. Discord Developer Portal で Application / Bot を作成する。
2. Bot をサーバーに招待する。
   - `applications.commands`
   - フォーラムスレッドへ返信させるための基本的な送信権限
3. Vercel / `.env.local` に以下を設定する。
   - `DISCORD_APPLICATION_ID`
   - `DISCORD_PUBLIC_KEY`
   - `DISCORD_BOT_TOKEN`
   - `DISCORD_FORUM_CHANNEL_ID`（フォーラム親チャネルID）
   - 任意: `DISCORD_COMMAND_NAME`（既定 `schedule`）
   - 任意: `DISCORD_GUILD_ID`（開発中は guild command 登録にすると反映が速い）
4. Discord Developer Portal の **Interactions Endpoint URL** に以下を設定する。

   ```
   https://<your-app>.vercel.app/api/discord/interactions
   ```

5. slash command を登録する。

   ```powershell
   npm run discord:register
   ```

6. 対象フォーラムチャネルで投稿を作り、そのスレッド内で実行する。

   ```
   /schedule message:登録済みの予定を確認して
   ```

### 8.3 注意点

- Discord Interactions は3秒以内に初回応答が必要なため、まず deferred response を返し、
  Agent の処理完了後に original response を編集して返答を表示する。
- Vercel の関数実行時間内で Agent 応答まで完了する必要があるため、`maxDuration = 300` を設定している。
- §8 の serverless endpoint 単体は slash command 経由。ユーザーがスレッドに普通の文章を投稿しただけで Bot が読む方式は、
  Discord Gateway の常時接続 Bot が必要になるため、§9 の常駐Botモードを併用する。

---

## 9. Discord 常駐Botモード（スレッドに普通に投稿して会話）

§8 の slash command 方式に加えて、**フォーラムスレッドに普通に投稿すると Bot が返信する**
自然な会話モードも用意している（`scripts/discord-bot.mjs`）。両方式は併用でき、
セッションキー（`discord:guild:<guild_id>:thread:<thread_id>`）を共有するので、
どちらの入口で送っても同じスレッドなら同じ Managed Agent セッションが継続する。

```
[Discord Forum Thread]   ← 普通のメッセージ投稿
        │  Gateway WebSocket (MESSAGE_CREATE)
        ▼
[scripts/discord-bot.mjs]  ← 常駐プロセス（Node 22+ 組み込み WebSocket）
        │  POST /api/discord/message  (Bearer GATEWAY_TOKEN)
        ▼
[schedule-gateway]  thread_id を user_key 化
        ▼
[gateway_sessions] → [Claude Managed Agents API]
        │
        ▼  返答を同じスレッドへ reply
[Discord Forum Thread]
```

### 9.1 仕組み

- 常駐 Bot が Discord Gateway に WebSocket 接続し、`MESSAGE_CREATE` を購読する。
- 対象が「フォーラム親チャネル配下のスレッド」内の投稿のときだけ反応する
  （`DISCORD_FORUM_CHANNEL_ID` 未設定なら全スレッド対象）。
- 投稿本文を `/api/discord/message` に渡し、gateway → Managed Agent の応答を同じスレッドへ返信する。
- セッション分離は §8.1 と同一。同じスレッド=継続 / 別スレッド=独立 / Web(`me`)とも独立。

### 9.2 必要な設定

1. Discord Developer Portal の Bot 設定で **MESSAGE CONTENT INTENT** を ON にする
   （スレッド本文を読むために必須）。
2. 環境変数を設定する（`.env.example` 参照）。
   - `DISCORD_BOT_TOKEN`
   - `GATEWAY_BASE_URL`（例: `https://<your-app>.vercel.app`）
   - `GATEWAY_TOKEN`（Web と共通）
   - 任意: `DISCORD_FORUM_CHANNEL_ID`（監視するフォーラム親チャネル）
   - 任意: `DISCORD_REQUIRE_MENTION=1`（Bot メンション時のみ反応させたい場合）
3. 常駐プロセスを起動する（Vercel ではなく、常時起動できる環境＝Railway/Render/VPS/自宅サーバ等）。

   ```powershell
   npm run discord:bot
   ```

### 9.3 slash command 方式（§8）との使い分け

| | slash command (`/schedule`) | 常駐Bot（普通の投稿） |
|---|---|---|
| 実行環境 | Vercel serverless のみで完結 | 常時起動プロセスが別途必要 |
| UX | 毎回 `/schedule message:` 入力 | スレッドに普通に書くだけ |
| MESSAGE CONTENT INTENT | 不要 | 必須 |
| セッションキー | 共通（同じスレッドなら継続） | 共通（同じスレッドなら継続） |

どちらか一方だけでも、両方同時でも運用できる。
