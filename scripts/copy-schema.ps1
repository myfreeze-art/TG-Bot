<#
.SYNOPSIS
    Копирует SQL-схему в буфер обмена, чтобы вставить его в D1 Console в браузере.

.DESCRIPTION
    Для деплоя через Cloudflare Dashboard без терминала:
      1. D1 → ваша база → Console
      2. Ctrl+V (скрипт уже положил SQL в буфер)
      3. Execute

    Сам SQL в консоль не выводится, чтобы не заполнять экран — он большой.
#>
[CmdletBinding()]
param(
    [string]$File = 'migrations/0001_init.sql'
)

$ErrorActionPreference = 'Stop'

$candidates = @($File)
if (-not (Test-Path $File)) {
    foreach ($alt in @('migrations\0001_init.sql', '..\migrations\0001_init.sql')) {
        if (Test-Path $alt) { $candidates += $alt; break }
    }
}
$path = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $path) { throw "Не найден SQL-файл '$File'. Запустите скрипт из папки anon-msg-bot." }

$sql = Get-Content -LiteralPath (Resolve-Path $path).Path -Raw -Encoding utf8
Set-Clipboard -Value $sql

$tables = ([regex]::Matches($sql, 'CREATE TABLE IF NOT EXISTS\s+(\w+)') | ForEach-Object { $_.Groups[1].Value }) -join ', '
Write-Host "Готово! SQL ($($sql.Length) символов) скопирован в буфер обмена." -ForegroundColor Green
Write-Host "Таблицы: $tables"
Write-Host ''
Write-Host 'Дальше: Cloudflare Dashboard → D1 → ваша база → Console → Ctrl+V → Execute.' -ForegroundColor Cyan
