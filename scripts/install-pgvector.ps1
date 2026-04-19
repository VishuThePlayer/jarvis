param(
    [string]$PgRoot = "C:\Program Files\PostgreSQL\18",
    [string]$Database = "jarvis",
    [string]$User = "postgres",
    [string]$PgHost = "localhost",
    [string]$PgVectorVersion = "v0.8.2"
)

$ErrorActionPreference = "Stop"

function Require-Command {
    param([string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name"
    }
}

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
    throw "Run this script from an Administrator PowerShell window."
}

if (-not (Test-Path $PgRoot)) {
    throw "PostgreSQL root not found: $PgRoot"
}

Require-Command git
Require-Command nmake
Require-Command psql

$tempRoot = Join-Path $env:TEMP "jarvis-pgvector-install"
$repoPath = Join-Path $tempRoot "pgvector"

if (Test-Path $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $tempRoot | Out-Null

Write-Host "Cloning pgvector $PgVectorVersion ..."
git clone --branch $PgVectorVersion https://github.com/pgvector/pgvector.git $repoPath

Push-Location $repoPath
try {
    $env:PGROOT = $PgRoot

    Write-Host "Building pgvector ..."
    nmake /F Makefile.win

    Write-Host "Installing pgvector into $PgRoot ..."
    nmake /F Makefile.win install
}
finally {
    Pop-Location
}

Write-Host "Creating extension in database '$Database' ..."
psql -h $PgHost -U $User -d $Database -c "CREATE EXTENSION IF NOT EXISTS vector;"

Write-Host ""
Write-Host "pgvector install complete."
Write-Host "You can now set ENABLE_PGVECTOR=true in .env and restart Jarvis."
