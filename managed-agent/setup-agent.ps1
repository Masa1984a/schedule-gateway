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

# MCP 設定（公式仕様）:
#  - Agent 作成時に mcp_servers（type/name/url のみ・認証なし）と
#    tools の mcp_toolset を宣言する。
#  - 認証トークンは Vault に static_bearer として登録する。
#  - Session 作成時に vault_ids でその Vault を参照する（mcp_servers は Session 不可）。
$mcpUrl   = $env:MCP_SERVER_URL
$mcpToken = $env:GATEWAY_TOKEN
$mcpName  = 'schedule-db'
$useMcp   = [bool]($mcpUrl -and $mcpToken)
if (-not $useMcp) {
  throw "MCP_SERVER_URL と GATEWAY_TOKEN を環境変数に設定してから実行してください（MCP 方式で Agent を構成します）。"
}

# --- 1. Agent ---
Write-Host "Agent を作成中..."
# mcp_toolset は既定が always_ask（承認待ち）。bootstrap時代の bash 同様に
# 自動実行させるため always_allow を明示する（破壊的操作の確認は各スキルが会話で取る）。
$tools = @(
  @{ type = 'agent_toolset_20260401' },
  @{
    type            = 'mcp_toolset'
    mcp_server_name = $mcpName
    default_config  = @{ permission_policy = @{ type = 'always_allow' } }
  }
)
$agentBody = @{
  name        = $AgentName
  model       = $Model
  system      = $system
  tools       = $tools
  skills      = $skills
  mcp_servers = @(@{ type = 'url'; name = $mcpName; url = $mcpUrl })
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

# --- 3. Vault + static_bearer クレデンシャル ---
# VAULT_ID が既にあれば再利用、無ければ新規作成。
# クレデンシャルは mcp_server_url が Agent の mcp_servers.url と完全一致する必要がある。
$vaultId = $env:VAULT_ID
if ($vaultId) {
  Write-Host "既存 Vault を使用: $vaultId"
} else {
  Write-Host "Vault を作成中..."
  $vaultBody = @{ display_name = 'schedule-gateway' } | ConvertTo-Json
  $vault = Invoke-RestMethod -Method Post -Uri 'https://api.anthropic.com/v1/vaults' -Headers $headers -Body $vaultBody
  $vaultId = $vault.id
  Write-Host "  Vault ID: $vaultId"
}

Write-Host "static_bearer クレデンシャルを登録中..."
$credBody = @{
  display_name = 'schedule-db gateway token'
  auth = @{
    type           = 'static_bearer'
    mcp_server_url = $mcpUrl
    token          = $mcpToken
  }
} | ConvertTo-Json -Depth 10
try {
  $cred = Invoke-RestMethod -Method Post -Uri "https://api.anthropic.com/v1/vaults/$vaultId/credentials" -Headers $headers -Body $credBody
  Write-Host "  Credential ID: $($cred.id)"
} catch {
  # 409 = 同じ mcp_server_url のクレデンシャルが既に存在（再実行時）
  if ($_.Exception.Response.StatusCode.value__ -eq 409) {
    Write-Host "  既存クレデンシャルあり（同一 mcp_server_url）。トークンを更新したい場合は archive してから再作成してください。"
  } else {
    throw
  }
}

# --- 4. Session（vault_ids で Vault を参照） ---
Write-Host "Session を作成中..."
$sessBody = @{
  agent          = $agent.id
  environment_id = $environment.id
  title          = 'Schedule management session'
  vault_ids      = @($vaultId)
} | ConvertTo-Json -Depth 10
$session = Invoke-RestMethod -Method Post -Uri 'https://api.anthropic.com/v1/sessions' -Headers $headers -Body $sessBody
Write-Host "  Session ID: $($session.id)"

# bootstrap は MCP 方式では不要。DATABASE_URL はサーバ側 env に留まる。

# --- 保存 ---
$out = [ordered]@{
  agent_id       = $agent.id
  agent_version  = $agent.version
  environment_id = $environment.id
  session_id     = $session.id
  vault_id       = $vaultId
  mcp_server_url = $mcpUrl
  created_at     = (Get-Date).ToString('o')
}
$outPath = Join-Path $PSScriptRoot 'agent-ids.json'
$out | ConvertTo-Json | Set-Content -LiteralPath $outPath -Encoding utf8

Write-Host ""
Write-Host "完了。ID は agent-ids.json に保存しました。"
Write-Host ""
Write-Host "=== 次のステップ ==="
Write-Host "Vercel と .env.local に以下を設定してください:"
Write-Host "  AGENT_ID=$($agent.id)"
Write-Host "  ENVIRONMENT_ID=$($environment.id)"
Write-Host "  VAULT_ID=$vaultId"
Write-Host "  MCP_SERVER_URL=$mcpUrl"
Write-Host "3. .env.local の AGENT_ID / ENVIRONMENT_ID を更新する:"
Write-Host "   AGENT_ID=$($agent.id)"
Write-Host "   ENVIRONMENT_ID=$($environment.id)"
