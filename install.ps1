# kimi-purge 一键安装（Windows）
# 用法：powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw '未找到 node.exe —— kimi-purge 需要 Node.js 18+（内置 fetch）。请先安装：https://nodejs.org/'
}
Write-Host '== kimi-purge 安装 =='
& node.exe (Join-Path $root 'scripts\kimi-purge.mjs') install
if ($LASTEXITCODE -ne 0) { throw 'install 失败' }
Write-Host ''
Write-Host '引擎补丁（apply）需要 Kimi Code 已完全退出。'
$ans = Read-Host '现在应用引擎补丁吗？(y/N)'
if ($ans -eq 'y' -or $ans -eq 'Y') {
  & node.exe (Join-Path $root 'scripts\kimi-purge.mjs') apply
  if ($LASTEXITCODE -ne 0) { throw 'apply 失败' }
  Write-Host '完成。重启 Kimi Code 后生效，会话里说 "purge probe" 验证。'
} else {
  Write-Host '跳过。之后运行: node scripts\kimi-purge.mjs apply（先退出 Kimi Code）'
}
