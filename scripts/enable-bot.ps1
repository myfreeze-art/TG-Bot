<#
.SYNOPSIS
    Включает бота: "main": "src/placeholder.ts" -> "src/index.ts" в корневом wrangler.jsonc.

.DESCRIPTION
    Заглушка нужна только для первого билда. Когда D1 создана, миграции применены и секреты
    (BOT_TOKEN, BOT_SECRET, TELEGRAM_WEBHOOK_SECRET) заданы в Cloudflare — переключите main
    на полный код бота и закоммитьте: Cloudflare пересоберёт воркер сам.

    Запуск (из папки, где лежит wrangler.jsonc):
      .\scripts\enable-bot.ps1
      .\scripts\enable-bot.ps1 -Placeholder      # вернуть заглушку

    Если тоже ошибка «выполнение сценариев отключено»:
      powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\enable-bot.ps1
#>
[CmdletBinding()]
param(
    [switch]$Placeholder,

    # Путь к файлу wrangler.jsonc. По умолчанию ищется: 1) в текущей папке, 2) уровнем выше.
    [string]$ConfigPath = ''
)

$ErrorActionPreference = 'Stop'

if (-not $ConfigPath) {
    $here = (Get-Location).Path
    $candidates = @(
        (Join-Path $here 'wrangler.jsonc'),
        (Join-Path $here 'wrangler.json'),
        (Join-Path (Split-Path -Parent $here) 'wrangler.jsonc')
    )
    $ConfigPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $ConfigPath) {
        throw 'Не найден wrangler.jsonc. Запустите скрипт из папки проекта или передайте -ConfigPath "<путь>".'
    }
}
$ConfigPath = (Resolve-Path $ConfigPath).Path
$projectRoot = Split-Path -Parent $ConfigPath

$target = if ($Placeholder) { 'src/placeholder.ts' } else { 'src/index.ts' }
if (-not (Test-Path (Join-Path $projectRoot $target))) {
    throw "Нет файла '$target' в $projectRoot — в репозитории должна быть папка src/ с кодом бота."
}

$content = Get-Content -LiteralPath $ConfigPath -Raw -Encoding utf8
if ($content -notmatch '"main"\s*:\s*"[^"]*"') {
    throw "В $ConfigPath нет поля `"main`". Это точно конфиг бота?"
}
$updated = [regex]::Replace($content, '"main"\s*:\s*"[^"]*"', ('"main": "' + $target + '"'))

if ($updated -eq $content) {
    Write-Host "Уже указано: main = $target — ничего не меняю." -ForegroundColor Yellow
} else {
    [System.IO.File]::WriteAllText($ConfigPath, $updated, [System.Text.UTF8Encoding]::new($false))
    Write-Host "Готово: $ConfigPath" -ForegroundColor Green
    Write-Host "       main = $target"
}

Write-Host ''
Write-Host 'Дальше: commit + push в GitHub (или Retry deployment в Cloudflare).' -ForegroundColor Cyan
Write-Host 'Проверка: https://anon-msg-bot.<subdomain>.workers.dev/health -> "configured":true'
