---
name: register-event
description: >
  新しい登壇・イベント予定を1件DBに登録する。登録前にコンフリクト（時間重複）を
  自動チェックし、物理的な移動が必要な場合はtravel_routesマスタを参照して移動時間を考慮し
  警告する。移動ブロックの自動生成も提案する。
  「予定を追加」「登壇が入った」「新しいイベント」「〇月〇日に〜がある」のように
  ユーザーが新しい予定について言及したらこのスキルを使う。
  既存予定の変更にはupdate-eventスキルを使うこと。
---

# 新規予定登録

## 前提

DBへのアクセスはすべて **MCPツール** 経由で行う。bash + neon_client.sh は使わない。

## 手順

1. ユーザーから以下の情報を収集（不足分は質問して補完）：
   - title（必須）
   - 日時: start_at, end_at（必須、`+09:00` 付き）
   - location（必須）
   - is_online（「オンライン」を含むか推定、確認）
   - category（推定して提示、確認）
   - notes（任意）

2. **登録前コンフリクトチェック**（必ず実行）：
   MCPツール `check_conflicts` を呼び出す:
   ```
   check_conflicts(start_at=<開始日時>, end_at=<終了日時>)
   ```
   結果に重複があれば警告してユーザーに確認を求める。

3. **移動必要性チェック**（新規予定がオフラインの場合）：
   - MCPツール `get_events` で前後の予定を確認する（例: 前後3日間）
   - 都市が異なるオフライン予定がある場合、MCPツール `get_travel_time` で移動時間を取得する:
     ```
     get_travel_time(from_city=<出発都市>, to_city=<到着都市>)
     ```
   - 移動時間が確保できない場合 → 警告
   - 移動ブロックが未登録の場合 → 自動生成を提案

4. ユーザーの確認後、MCPツール `register_event` を呼び出す:
   ```
   register_event(
     title=<タイトル>,
     start_at=<開始日時>,
     end_at=<終了日時>,
     location=<場所>,
     is_online=<true/false>,
     category=<カテゴリ>,
     notes=<備考（省略可）>
   )
   ```

5. **移動ブロック提案**（該当する場合）：
   - 例: 「4/27 函館の予定の前に、札幌→函館の移動（JR北斗 3.5時間）を登録しますか？」
   - 承認されたら MCPツール `register_event` で category='travel', travel_from, travel_to, travel_mode を設定して登録する:
     ```
     register_event(
       title="🚄 札幌→函館（JR北斗）",
       start_at=<出発日時>,
       end_at=<到着日時>,
       location="移動中",
       is_online=false,
       category="travel",
       travel_from="札幌市",
       travel_to="函館市",
       travel_mode="train",
       notes="JR北斗 約3.5時間"
     )
     ```

6. 登録完了後、登録内容をサマリ表示

## Gotchas

- タイムゾーンは `+09:00` 固定（DB は TIMESTAMPTZ で UTC 保存される）
- ユーザーが「来週の木曜」のような相対日時を使う場合は、今日の日付から算出する
- 終了時刻が未指定の場合、登壇系は90分、会議系は60分、懇親会系は3時間をデフォルト
- 移動ブロックの title は「🚄 札幌→函館（JR北斗）」のように移動手段の絵文字と経路を含める
- 飛行機移動は空港アクセス時間を含めた全体時間で登録する（フライト時間だけにしない）
