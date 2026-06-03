<#
.SYNOPSIS
  Claude Managed Agents の Agent / Environment / Session を作成する（MCP方式）。

.DESCRIPTION
  1. skill-ids.json の 5 スキルを束ねた Agent を作成
  2. cloud + unrestricted networking の Environment を作成
  3. Session を作成（MCP_SERVER_URL が設定されていれば mcp_servers を追加）
  4. 生成 ID を managed-agent/agent-ids.json に保存

  ⚠ bootstrap は不要になりました。
  DATABASE_URL は schedule-gateway の /api/mcp MCP サーバが保持し、
  Agent のサンドボックスやイベントログには一切露出しません。

  MCP_SERVER_URL の設定方法:
    Vercel にデプロイ後、環境変数 MCP_SERVER_URL に
    https://<your-app>.vercel.app/api/mcp を設定してください。

.NOTES
  要: 環境変数 ANTHROPIC_API_KEY。
  MCP_SERVER_URL と GATEWAY_TOKEN が設定されていれば mcp_servers を Session に追加します。
#>
[CmdletBinding()]
param(
  [string]$RepoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$Model      = 'claude-opus-4-8',
  [string]$AgentName  = 'Schedule Manager',
  [string]$EnvName    = ('schedule-env-' + (Get-Date -Format 'yyyyMMddHHmmss'))
)

$ErrorActionPreference = 'Stop'
if (-not $env:ANTHROPIC_API_KEY) { throw "環境変数 ANTHROPIC_API_KEY が未設定です。" }

$beta = 'managed-agents-2026-04-01'
$headers = @{
  'x-api-key'         = $env:ANTHROPIC_API_KEY
  'anthropic-version' = '2023-06-01'
  'anthropic-beta'    = $beta
  'content-type'      = 'application/json'
}

# --- skill-ids.json ---
$idsPath = Join-Path $PSScriptRoot 'skill-ids.json'
if (-not (Test-Path $idsPath)) { throw "skill-ids.json が無い。先に upload-skills.ps1 を実行してください。" }
$ids = Get-Content -Raw $idsPath | ConvertFrom-Json

$skills = @()
foreach ($p in $ids.PSObject.Properties) {
  $skills += @{ type = 'custom'; skill_id = $p.Value; version = 'latest' }
}

$system = @"
あなたは登壇・イベントのスケジュール管理アシスタントです。
データは Neon (PostgreSQL) の speaking_events / travel_routes に保存されています。
DB アクセスは MCP ツール（schedule-db サーバ）経由で行います。

利用可能なMCPツール:
- get_events: 期間内の予定一覧取得
- search_events: タイトル部分一致検索
- check_conflicts: 時間重複確認
- get_travel_time: 都市間移動時間取得
- get_travel_routes: 移動ルートマスタ一覧
- get_nearby_travel_blocks: 近接する移動ブロック取得
- register_event: 予定登録（通常予定・移動ブロック共通）
- update_event: 予定更新
- delete_event: 予定削除
- import_events: 予定一括登録
- upsert_travel_route: 移動ルートマスタ更新

ルール:
- 予定の追加/変更/確認/一括取込/移動手配は、必ず対応するスキルの手順に従う。
- 日時のタイムゾーンは +09:00 固定。DB は TIMESTAMPTZ(UTC) で保存される。
- 予定登録・変更の前に必ず check_conflicts でコンフリクトチェックを行う。
- オフライン予定では都市間移動の要否を get_travel_time で確認し、必要なら移動ブロックを提案する。
- 削除前は必ずユーザーの最終確認を取る。
"@

# --- 1. Agent ---
Write-Host "Agent を作成中..."
$agentBody = @{
  name   = $AgentName
  model  = $Model
  system = $system
  tools  = @(@{ type = 'agent_toolset_20260401' })
  skills = $skills
} | ConvertTo-Json -Depth 10
$agent = Invoke-RestMethod -Method Post -Uri 'https://api.anthropic.com/v1/agents' -Headers $headers -Body $agentBody
Write-Host "  Agent ID: $($agent.id) (v$($agent.version))"

# --- 2. Environment ---
Write-Host "Environment を作成中..."
$envBody = @{
  name   = $EnvName
  config = @{ type = 'cloud'; networking = @{ type = 'unrestricted' } }
} | ConvertTo-Json -Depth 10
$environment = Invoke-RestMethod -Method Post -Uri 'https://api.anthropic.com/v1/environments' -Headers $headers -Body $envBody
Write-Host "  Environment ID: $($environment.id)"

# --- 3. Session ---
Write-Host "Session を作成中..."

$sessData = [ordered]@{
  agent          = $agent.id
  environment_id = $environment.id
  title          = 'Schedule management session'
}

# MCP_SERVER_URL が設定されていれば mcp_servers を追加
$mcpUrl   = $env:MCP_SERVER_URL
$mcpToken = $env:GATEWAY_TOKEN
if ($mcpUrl -and $mcpToken) {
  Write-Host "  MCP サーバを設定: $mcpUrl"
  $sessData.mcp_servers = @(@{
    type                = 'url'
    url                 = $mcpUrl
    name                = 'schedule-db'
    authorization_token = $mcpToken
  })
} else {
  Write-Host "  ⚠ MCP_SERVER_URL または GATEWAY_TOKEN が未設定のため mcp_servers なしで作成します。"
  Write-Host "    Vercel にデプロイ後、これらの環境変数を設定して再実行してください。"
}

$sessBody = $sessData | ConvertTo-Json -Depth 10
$session = Invoke-RestMethod -Method Post -Uri 'https://api.anthropic.com/v1/sessions' -Headers $headers -Body $sessBody
Write-Host "  Session ID: $($session.id)"

# bootstrap は MCP 方式では不要。DATABASE_URL はサーバ側 env に留まる。

# --- 保存 ---
$out = [ordered]@{
  agent_id       = $agent.id
  agent_version  = $agent.version
  environment_id = $environment.id
  session_id     = $session.id
  created_at     = (Get-Date).ToString('o')
}
$outPath = Join-Path $PSScriptRoot 'agent-ids.json'
$out | ConvertTo-Json | Set-Content -LiteralPath $outPath -Encoding utf8

Write-Host ""
Write-Host "完了。ID は agent-ids.json に保存しました。"
Write-Host ""
Write-Host "=== 次のステップ ==="
Write-Host "1. Vercel にデプロイして MCP_SERVER_URL を確認する"
Write-Host "   例: https://<your-app>.vercel.app/api/mcp"
Write-Host "2. Vercel の環境変数に MCP_SERVER_URL を設定する"
Write-Host "3. .env.local の AGENT_ID / ENVIRONMENT_ID を更新する:"
Write-Host "   AGENT_ID=$($agent.id)"
Write-Host "   ENVIRONMENT_ID=$($environment.id)"
