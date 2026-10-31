<#
.SYNOPSIS
    Генерирует секреты для бота и выводит команды для GitHub Actions — повторно, без действий в Cloudflare.

.DESCRIPTION
    1. Выполните в PowerShell:
         .\scripts\make-secrets.ps1 -BotToken "123456789:AA..." -BotUsername "my_anon_bot"
    2. Скрипт создаст два случайных секрета (BOT_SECRET, TELEGRAM_WEBHOOK_SECRET) и напишет готовый блок
       в bot.env.example.
    3. В GitHub: Settings → Secrets and variables → Actions:
       - вкладка "Secrets" → New repository secret: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
         BOT_TOKEN, BOT_SECRET, TELEGRAM_WEBHOOK_SECRET
       - вкладка "Variables" → New repository variable: ADMIN_IDS, BOT_USERNAME, D1_DATABASE_ID

    Значения секретов вводятся в GitHub один раз; бот меняет настройки уже в Cloudflare (Settings → Variables).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BotToken,

    [string]$BotUsername = '',

    [string]$AdminIds = '123456789',

    [string]$DatabaseId = 'ВСТАВЬ_ID_ИЗ_D1',

    [string]$AccountId = 'ВСТАВЬ_ACCOUNT_ID',

    [string]$OutFile = 'bot.env.example'
)

$ErrorActionPreference = 'Stop'

if ($BotToken -notmatch '^\d+:[A-Za-z0-9_-]{20,}$') {
    throw 'BotToken должен выглядеть как 123456789:AA... Без кавычек и пробелов.'
}

function New-Secret([int]$bytes = 32) {
    $buffer = New-Object byte[] $bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
    return ($buffer | ForEach-Object { $_.ToString('x2') }) -join ''
}

$botSecret = New-Secret 32
$webhookSecret = New-Secret 32

$content = @"
# Сгенерировано scripts/make-secrets.ps1 — НЕ коммитьте этот файл в git.
# Нужно для GitHub Actions (деплой и установка webhook).

# --- GitHub → Settings → Secrets and variables → Actions → Secrets ---
CLOUDFLARE_API_TOKEN=<вставьте токен из dash.cloudflare.com/profile/api-tokens>
CLOUDFLARE_ACCOUNT_ID=$AccountId
BOT_TOKEN=$BotToken
BOT_SECRET=$botSecret
TELEGRAM_WEBHOOK_SECRET=$webhookSecret

# --- GitHub → Settings → Secrets and variables → Actions → Variables ---
ADMIN_IDS=$AdminIds
BOT_USERNAME=$($BotUsername.TrimStart('@'))
D1_DATABASE_ID=$DatabaseId
"@

$outPath = Join-Path (Get-Location) $OutFile
[System.IO.File]::WriteAllText($outPath, $content, [System.Text.UTF8Encoding]::new($false))

Write-Host "Готово. Секреты записаны в $OutFile" -ForegroundColor Green
Write-Host ''
Write-Host 'CLOUDFLARE_API_TOKEN в файле — заглушка, его создайте вручную:' -ForegroundColor Yellow
Write-Host '  https://dash.cloudflare.com/profile/api-tokens → Create Token → Edit Cloudflare Workers'
Write-Host '  (если в списке шаблон разрешает D1 — добавьте разрешение Account → D1 → Edit)'
Write-Host ''
Write-Host 'DAILY_DIGEST_HOUR_UTC не нужен: он задаётся в Cloudflare vars.'
Write-Host 'После вставки в GitHub удалите файл:' -NoNewline
Write-Host $OutFile -ForegroundColor Cyan
