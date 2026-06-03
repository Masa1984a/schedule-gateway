---
name: import-events
description: >
  テキストやマークダウン形式の予定リストをパースしてspeaking_eventsテーブルに一括登録する。
  このスキルは、ユーザーが複数の予定をまとめて登録したいとき、テキストから予定を読み取って
  インポートしたいとき、「予定を一括登録」「まとめて入れて」「このリストをDBに入れて」と
  言ったときに使う。予定データのフォーマットが明示されていなくても、テキストに日時・タイトル・
  場所が含まれていればこのスキルを使うこと。
---

# 予定一括インポート

## 前提

DBへのアクセスはすべて **MCPツール** 経由で行う。bash + neon_client.sh は使わない。

## 手順

1. ユーザーから予定データ（テキスト/マークダウン）を受け取る

2. 各予定から以下を抽出する：
   - title: イベント名
   - start_at / end_at: 開始・終了日時（TIMESTAMPTZ、`+09:00` をデフォルト）
   - location: 場所
   - is_online: 「オンライン」を含む場合は true
   - category: 以下のルールで推定
     - 「授業」「大学」「高専」→ lecture
     - 「登壇」「イベント」「AMA」→ speaking
     - 「懇親会」「お疲れ会」「慰労会」→ social
     - 「Talent Discussion」「Officewide」→ internal
     - 「健康診断」→ health
     - 「移動」「フライト」「新幹線」→ travel
     - それ以外 → other

3. パース結果を一覧表示してユーザーに確認を求める

4. 確認後、MCPツール `import_events` を呼び出す:
   ```
   import_events(events=[
     {
       "title": "Findy主催 Claude Code Skills実践！",
       "start_at": "2026-04-09T11:30:00+09:00",
       "end_at": "2026-04-09T13:30:00+09:00",
       "location": "札幌市",
       "is_online": false,
       "category": "speaking",
       "notes": ""
     },
     ...
   ])
   ```

5. 登録後、コンフリクト確認を実施：
   - MCPツール `check_conflicts` を主要な時間帯について呼び出す
   - または MCPツール `get_events` で登録した期間全体を取得してコンフリクト分析を行う

6. 異なる都市間のオフライン予定が連続する場合、移動ブロックの登録を提案する（manage-travel スキルへ案内）

## Gotchas

- タイムゾーンは必ず `+09:00`（JST）を付与する。ユーザーが省略しても補完すること
- 「札幌市(オンライン)」のような表記は location=札幌市, is_online=true と分離する
- 同一日に複数イベントがある場合（例: 報告会→慰労会）は別レコードとして登録
- category の自動推定結果は必ずユーザーに確認を取ること
- 登録前: `start_at < end_at` であることをチェックする
- 登録後: `import_events` の返却 `inserted` 件数が入力件数と一致することを確認する
