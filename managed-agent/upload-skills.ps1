<#
.SYNOPSIS
  build-skills.ps1 が生成した zip を Claude Skills API にアップロードする。

.DESCRIPTION
  各 zip を POST /v1/skills（beta: skills-2025-10-02）でアップロードし、
  返ってきた skill_id を managed-agent/skill-ids.json に保存する。
  既に skill-ids.json がある場合は、各スキルを新バージョンとして
  POST /v1/skills/{id}/versions に上げる（--NewVersion 指定時）。

.PARAMETER NewVersion
  指定すると、skill-ids.json の既存 ID に対して新バージョンをアップロードする。

.PARAMETER Force
  指定すると、skill-ids.json に既出のスキルも再度「新規」アップロードする（重複作成に注意）。

.NOTES
  要: 環境変数 ANTHROPIC_API_KEY。multipart 送信には curl.exe を使用。
  curl のレスポンス（UTF-8 JSON。日本語 display_title を含む）は、PowerShell の
  コンソール出力エンコーディングによる文字化けを避けるため、一時ファイルに -o で受けて
  UTF-8 として読み直す。
#>
[CmdletBinding()]
param(
  [switch]$NewVersion,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

if (-not $env:ANTHROPIC_API_KEY) { throw "環境変数 ANTHROPIC_API_KEY が未設定です。" }

$distRoot = Join-Path $PSScriptRoot 'dist'
$idsPath  = Join-Path $PSScriptRoot 'skill-ids.json'
if (-not (Test-Path $distRoot)) { throw "dist が見つかりません。先に build-skills.ps1 を実行してください。" }

$curl = (Get-Command curl.exe -ErrorAction SilentlyContinue)?.Source
if (-not $curl) { throw "curl.exe が見つかりません（Windows 10/11 には標準同梱）。" }

# display_title マッピング（人間可読名・最大128字）
$titles = [ordered]@{
  'register-event'  = '予定登録'
  'update-event'    = '予定更新・削除'
  'check-conflicts' = '予定確認・コンフリクト'
  'import-events'   = '予定一括取込'
  'manage-travel'   = '移動手配'
}

$beta = 'skills-2025-10-02'
$ver  = '2023-06-01'

# 既存 ID（skill-ids.json があれば読み込み、スキップ判定/新バージョンに使用）
$existing = @{}
if (Test-Path $idsPath) {
  (Get-Content -Raw $idsPath | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $existing[$_.Name] = $_.Value }
}
if ($NewVersion -and -not (Test-Path $idsPath)) { throw "skill-ids.json が無いため -NewVersion できません。" }

# 結果は既存を引き継いで開始（スキップしたスキルのIDを保持するため）
$result = [ordered]@{}
foreach ($skill in $titles.Keys) { if ($existing.ContainsKey($skill)) { $result[$skill] = $existing[$skill] } }

foreach ($skill in $titles.Keys) {
  $zip = Join-Path $distRoot "$skill.zip"
  if (-not (Test-Path $zip)) { throw "zip が見つかりません: $zip" }

  $haveId = $existing.ContainsKey($skill)

  # 既にアップロード済みで、再アップロード指定が無ければスキップ
  if ($haveId -and -not $NewVersion -and -not $Force) {
    Write-Host "= [$skill] 既にアップロード済み（$($existing[$skill])）。スキップ。"
    continue
  }

  if ($NewVersion) {
    $id  = $existing[$skill]
    if (-not $id) { throw "skill-ids.json に $skill のIDがありません。" }
    $url = "https://api.anthropic.com/v1/skills/$id/versions"
    Write-Host "↑ [$skill] 新バージョンを $id にアップロード..."
  } else {
    $url = "https://api.anthropic.com/v1/skills"
    Write-Host "↑ [$skill] 新規アップロード..."
  }

  $args = @(
    '-sS','-X','POST', $url,
    '-H', "x-api-key: $($env:ANTHROPIC_API_KEY)",
    '-H', "anthropic-version: $ver",
    '-H', "anthropic-beta: $beta",
    '-F', "display_title=$($titles[$skill])",
    '-F', "files[]=@$zip"
  )

  # レスポンスは一時ファイルに UTF-8 で受けて読み直す（コンソール復号による文字化け回避）
  $tmp = New-TemporaryFile
  try {
    & $curl @args '-o' $tmp.FullName
    if ($LASTEXITCODE -ne 0) { throw "curl 失敗 ($skill): exit $LASTEXITCODE" }
    $raw = Get-Content -Raw -LiteralPath $tmp.FullName -Encoding utf8
  } finally {
    Remove-Item -LiteralPath $tmp.FullName -Force -ErrorAction SilentlyContinue
  }

  $obj = $raw | ConvertFrom-Json
  if (-not $obj.id) { throw "アップロード応答に id がありません ($skill): $raw" }

  $result[$skill] = $obj.id
  Write-Host "  -> id=$($obj.id) version=$($obj.latest_version ?? $obj.version)"
}

$result | ConvertTo-Json | Set-Content -LiteralPath $idsPath -Encoding utf8
Write-Host ""
Write-Host "完了: skill-ids.json を保存しました。"
Write-Host "次は: .\setup-agent.ps1 で Agent / Environment / Session を作成"
