<#
.SYNOPSIS
  MCP 方式用スキルバンドルを生成する。

.DESCRIPTION
  managed-agent/dist/<skill>/SKILL.md を zip に圧縮する。
  MCP 方式では neon_client.sh は不要。SKILL.md のみ同梱する。

  zip の構造: <skill>/SKILL.md

.NOTES
  SKILL.md を編集したら本スクリプトで zip を再生成し、
  upload-skills.ps1 で -NewVersion フラグ付きで再アップロードすること。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$distRoot = Join-Path $PSScriptRoot 'dist'
$skills   = @('register-event', 'update-event', 'check-conflicts', 'import-events', 'manage-travel')

foreach ($skill in $skills) {
  $skillMd = Join-Path $distRoot "$skill\SKILL.md"
  if (-not (Test-Path $skillMd)) {
    throw "SKILL.md が見つかりません: $skillMd"
  }

  $zipPath = Join-Path $distRoot "$skill.zip"
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

  Compress-Archive -Path (Join-Path $distRoot $skill) -DestinationPath $zipPath -Force
  Write-Host "✓ $skill -> $zipPath"
}

Write-Host ""
Write-Host "完了: $distRoot に 5 スキルの zip を生成しました。"
Write-Host "次は: .\upload-skills.ps1 -NewVersion でアップロード"
