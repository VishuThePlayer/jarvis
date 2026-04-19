# Scaffolds a new Jarvis tool (wrapper around scripts/scaffold-tool.mjs).
#
# Usage:
#   ./scripts/new-tool.ps1 my-tool
#   ./scripts/new-tool.ps1 weather --kind command --command weather
#   ./scripts/new-tool.ps1 redact --kind pre-model

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$ToolId,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

$ErrorActionPreference = 'Stop'

node scripts/scaffold-tool.mjs $ToolId @Args

Write-Host ''
Write-Host 'Next:'
Write-Host ('1) Implement src/tools/{0}.ts' -f $ToolId)
Write-Host '2) Enable the tool env flag in .env'
Write-Host '3) Run: npm test'
