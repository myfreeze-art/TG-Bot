<#
.SYNOPSIS
    Устанавливает webhook и список команд для anon-msg-bot.

.EXAMPLE
    .\scripts\setup-webhook.ps1 `
      -BotToken "123456:ABC..." `
      -WorkerUrl "https://anon-msg-bot.username.workers.dev" `
      -WebhookSecret "секрет_из_wrangler_secret"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BotToken,

    [Parameter(Mandatory = $true)]
    [string]$WorkerUrl,

    [Parameter(Mandatory = $true)]
    [string]$WebhookSecret
)

$ErrorActionPreference = 'Stop'

if ($BotToken -notmatch '^\d+:[A-Za-z0-9_-]{20,}$') {
    throw 'BotToken должен выглядеть как 123456789:AA... Двойные кавычки при вставке не нужны.'
}
if ($WebhookSecret -notmatch '^[A-Za-z0-9_-]{1,256}$') {
    throw 'WebhookSecret должен состоять из A-Z a-z 0-9 _ - и быть не длиннее 256 символов.'
}
if ($WorkerUrl -notmatch '^https://') {
    throw 'WorkerUrl должен начинаться с https://'
}

$base = "https://api.telegram.org/bot$BotToken"
$url = $WorkerUrl.TrimEnd('/') + '/'

$me = Invoke-RestMethod -Uri "$base/getMe" -Method Get
if (-not $me.ok) { throw "getMe failed: $($me.description)" }
Write-Host "Бот: @$($me.result.username)" -ForegroundColor Cyan

$payload = @{
    url                  = $url
    secret_token         = $WebhookSecret
    allowed_updates      = @('message', 'callback_query')
    drop_pending_updates = $false
} | ConvertTo-Json -Depth 5

$result = Invoke-RestMethod -Method Post -Uri "$base/setWebhook" `
    -ContentType 'application/json; charset=utf-8' `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($payload))
if (-not $result.ok) { throw "setWebhook failed: $($result.description)" }
Write-Host "Webhook: $url" -ForegroundColor Green

$commands = @(
    @{ command = 'start';    description = 'Главное меню' },
    @{ command = 'link';     description = 'Моя анонимная ссылка' },
    @{ command = 'stats';    description = 'Статистика ящика' },
    @{ command = 'settings'; description = 'Настройки ящика' },
    @{ command = 'pause';    description = 'Не принимать сообщения' },
    @{ command = 'resume';   description = 'Снова принимать сообщения' },
    @{ command = 'lang';     description = 'Язык / Language' },
    @{ command = 'privacy';  description = 'Как работает анонимность' },
    @{ command = 'help';     description = 'Помощь' },
    @{ command = 'cancel';   description = 'Отменить действие' },
    @{ command = 'admin';    description = 'Панель администратора' }
) | ConvertTo-Json -Depth 3

$commandsResult = Invoke-RestMethod -Method Post -Uri "$base/setMyCommands" `
    -ContentType 'application/json; charset=utf-8' `
    -Body ([System.Text.Encoding]::UTF8.GetBytes("{`"commands`":$commands}"))
if (-not $commandsResult.ok) { throw "setMyCommands failed: $($commandsResult.description)" }
Write-Host 'Команды бота обновлены.' -ForegroundColor Green

Write-Host "`nИнформация о webhook:" -ForegroundColor Cyan
$info = Invoke-RestMethod -Uri "$base/getWebhookInfo" -Method Get
$info.result | Format-List url, pending_update_count, last_error_date, last_error_message
