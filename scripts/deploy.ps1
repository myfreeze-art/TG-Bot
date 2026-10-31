<#
.SYNOPSIS
    Локальный деплой anon-msg-bot (для тех, кто ставит бота с ПК, а не из GitHub).

.DESCRIPTION
    GitHub-деплой использует корневой wrangler.jsonc. Для локального деплоя можно:
      - задать database_id в корневом wrangler.jsonc и выполнить `npx wrangler deploy`, или
      - не трогать корневой конфиг и запустить этот скрипт:

          .\scripts\deploy.ps1 -DatabaseId "xxxx-..." -AdminIds "123456789" -BotUsername "my_bot" -Migrate -Bot

    Скрипт делает копию корневого конфига с настоящим database_id, src/ и migrations/
    во временной папке и вызывает `wrangler deploy <путь к копии>`.
#>
[CmdletBinding()]
param(
    [string]$DatabaseId,

    [switch]$CreateDatabase,

    [Parameter(Mandatory = $true)]
    [string]$AdminIds,

    [string]$BotUsername = '',

    [string]$DatabaseName = 'anon-msg-bot',

    [switch]$Migrate,

    [string]$DigestHourUtc = '9',

    [switch]$Bot,                # деплоить бота (src/index.ts), а не заглушку

    [switch]$KeepConfig,

    [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function New-TempConfig([string]$template) {
    $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("anon-msg-bot-config-{0}" -f ([guid]::NewGuid().ToString('N')))
    New-Item -ItemType Directory -Path $dir | Out-Null
    foreach ($sub in @('src', 'migrations', 'tests', 'node_modules')) {
        $source = Join-Path $projectRoot $sub
        if (Test-Path $source) {
            New-Item -ItemType Junction -Path (Join-Path $dir $sub) -Target (Resolve-Path $source) | Out-Null
        }
    }
    foreach ($file in @('package.json', 'tsconfig.json')) {
        $source = Join-Path $projectRoot $file
        if (Test-Path $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $dir $file) }
    }
    $temp = Join-Path $dir 'wrangler.jsonc'
    [System.IO.File]::WriteAllText($temp, $template, [System.Text.UTF8Encoding]::new($false))
    return $temp
}

function Remove-TempConfig([string]$tempConfig) {
    if (-not $tempConfig) { return }
    $dir = Split-Path -Parent $tempConfig
    $prefix = Join-Path ([System.IO.Path]::GetTempPath()) 'anon-msg-bot-config-'
    if ($dir -and $dir.StartsWith($prefix) -and (Test-Path $dir)) {
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if (-not $ConfigPath) {
    $candidates = @('wrangler.jsonc', 'wrangler.json', 'wrangler.toml') | Where-Object { Test-Path (Join-Path $projectRoot $_) }
    if (-not $candidates) { throw 'Не найден wrangler.jsonc. Запустите скрипт из папки anon-msg-bot.' }
    $ConfigPath = Join-Path $projectRoot $candidates[0]
}
$ConfigPath = (Resolve-Path $ConfigPath).Path
$template = Get-Content -LiteralPath $ConfigPath -Raw -Encoding utf8

if ($AdminIds -notmatch '^\s*\d+(\s*[,\s]\s*\d+)*\s*$') {
    throw 'AdminIds должен быть числом или списком чисел через запятую.'
}
$adminList = ($AdminIds -replace '\s', '')
$template = [regex]::Replace($template, '"ADMIN_IDS"\s*:\s*"[^"]*"', "`"ADMIN_IDS`": `"$adminList`"")
if ($BotUsername) {
    $botName = $BotUsername.TrimStart('@')
    $template = [regex]::Replace($template, '"BOT_USERNAME"\s*:\s*"[^"]*"', "`"BOT_USERNAME`": `"$botName`"")
}
$template = [regex]::Replace($template, '"DAILY_DIGEST_HOUR_UTC"\s*:\s*"[^"]*"', "`"DAILY_DIGEST_HOUR_UTC`": `"$DigestHourUtc`"")
if ($Bot) {
    $template = [regex]::Replace($template, '"main"\s*:\s*"[^"]*"', '"main": "src/index.ts"')
}

if ($CreateDatabase) {
    if ($DatabaseId) { throw 'Не передавайте -DatabaseId вместе с -CreateDatabase.' }
    Write-Host "Создаю D1 базу '$DatabaseName'…" -ForegroundColor Cyan
    $tempForCreate = New-TempConfig ([regex]::Replace($template, '"database_id"\s*:\s*"[^"]*"', '"database_id": "00000000-0000-0000-0000-000000000000"'))
    try {
        $output = & npx wrangler d1 create $DatabaseName --config $tempForCreate 2>&1 | Out-String
    } finally {
        Remove-TempConfig $tempForCreate
    }
    Write-Host $output
    $match = [regex]::Match($output, 'database_id\s*[=:]\s*"?([0-9a-fA-F-]{36})"?')
    if ($match.Success) {
        $DatabaseId = $match.Groups[1].Value
    } elseif ($output -match 'already exists') {
        throw "База '$DatabaseName' уже существует. Возьмите её database_id в Dashboard → D1 и передайте -DatabaseId."
    } else {
        throw 'Не удалось прочитать database_id из ответа wrangler.'
    }
    Write-Host "database_id: $DatabaseId" -ForegroundColor Green
}

if (-not $DatabaseId) {
    throw 'Укажите -DatabaseId "<id>" или -CreateDatabase.'
}
if ($DatabaseId -notmatch '^[0-9a-fA-F-]{36}$') {
    throw "database_id выглядит неверно: '$DatabaseId'"
}

$template = [regex]::Replace($template, '"database_id"\s*:\s*"[^"]*"', "`"database_id`": `"$DatabaseId`"")
if ($template -notmatch [regex]::Escape($DatabaseId)) { throw 'Не удалось подставить database_id в конфиг.' }

$temp = New-TempConfig $template
try {
    if ($Migrate) {
        Write-Host 'Применяю миграции D1…' -ForegroundColor Cyan
        & npx wrangler d1 migrations apply $DatabaseName --remote --config $temp
        if ($LASTEXITCODE -ne 0) { throw 'Миграции не применились.' }
    }

    Write-Host 'Деплою воркер…' -ForegroundColor Cyan
    & npx wrangler deploy $temp
    if ($LASTEXITCODE -ne 0) { throw 'wrangler deploy завершился с ошибкой.' }
} finally {
    if ($KeepConfig) {
        Write-Host "Временный конфиг сохранён: $temp" -ForegroundColor Yellow
    } else {
        Remove-TempConfig $temp
    }
}

Write-Host ''
Write-Host 'Готово. Если секреты ещё не заданы:' -ForegroundColor Green
Write-Host '  npx wrangler secret put BOT_TOKEN   (и BOT_SECRET, TELEGRAM_WEBHOOK_SECRET)'
Write-Host '  .\scripts\setup-webhook.ps1 -BotToken "..." -WorkerUrl "https://<worker>.workers.dev" -WebhookSecret "..."'
