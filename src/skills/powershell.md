---
name: powershell
description: >
  Use this skill whenever the task involves writing, debugging, refactoring, or explaining PowerShell
  code or scripts. Triggers include: automation tasks, system administration, file/registry/process
  operations, REST API calls via Invoke-RestMethod, scheduled jobs, CI/CD pipeline scripts, Azure/AWS
  CLI wrappers, Active Directory queries, module authoring, cross-platform pwsh scripts, and any
  request that mentions .ps1, .psm1, .psd1, cmdlets, or PowerShell syntax. Also triggers when the
  user asks to "automate", "schedule", or "batch" something on Windows, Linux, or macOS where
  PowerShell is a viable tool.
version: 1.0.0
---

# PowerShell Skill — Agent Reference

This skill gives you deep, opinionated guidance for writing production-quality PowerShell. Every
section maps to a real task class. When in doubt, follow the patterns here over general knowledge.

---

## 1. Language Fundamentals

### 1.1 Versioning — Know What You're Targeting

| Version | Engine    | Ships with             | Key feature              |
|---------|-----------|------------------------|--------------------------|
| 5.1     | Windows   | Windows 10/Server 2019 | Last WinPS release       |
| 7.x     | .NET 8+   | Manual install / pwsh  | Cross-platform, parallel |

Always check `$PSVersionTable.PSVersion`. Write `#Requires -Version 7.2` at the top when you use
7-only features (e.g., `ForEach-Object -Parallel`, null-coalescing `??`, ternary `? :`).

```powershell
#Requires -Version 7.2
#Requires -Modules Az.Accounts
```

### 1.2 Strict Mode — Always On

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'   # treat all errors as terminating
```

`Set-StrictMode -Version Latest` catches: uninitialized variables, out-of-bounds indexing, calling
non-existent properties on `$null`. Never ship a script without it.

### 1.3 Variables and Typing

Prefer explicit types on parameters and critical variables — it documents intent and catches bugs
at assignment rather than at use.

```powershell
[string]  $name    = 'Jarvis'
[int]     $port    = 8080
[bool]    $verbose = $false
[datetime]$start   = Get-Date
```

Use `[PSCustomObject]` over hashtables when the object will be piped or displayed:

```powershell
# Prefer
$record = [PSCustomObject]@{
    Id    = 42
    Name  = 'Alpha'
    Active = $true
}

# Over
$record = @{ Id = 42; Name = 'Alpha'; Active = $true }
```

### 1.4 String Handling

```powershell
# Interpolation — double-quotes only
$greeting = "Hello, $name. Today is $((Get-Date).DayOfWeek)."

# Verbatim — single-quotes, no interpolation
$pattern = 'C:\Users\$env:USERNAME'   # literal dollar sign

# Here-string — multiline, respects interpolation
$body = @"
Dear $name,
Your report is ready.
"@

# Format operator — cleaner than string concat
'{0} of {1} items processed ({2:P0})' -f $done, $total, ($done / $total)

# -f with padding
'{0,-20} {1,8}' -f $label, $value   # left-align 20, right-align 8
```

Never use `+` to build strings in loops — use `[System.Text.StringBuilder]` or collect into an
array and `-join`:

```powershell
$lines = foreach ($item in $collection) { "Item: $($item.Name)" }
$output = $lines -join "`n"
```

---

## 2. Functions and Modules

### 2.1 Advanced Function Template

Every non-trivial function must use `[CmdletBinding()]`. This unlocks `-Verbose`, `-Debug`,
`-WhatIf`, `-ErrorAction`, and pipeline binding for free.

```powershell
function Invoke-DataExport {
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
    param(
        [Parameter(Mandatory, ValueFromPipeline, HelpMessage = 'Source table name')]
        [ValidateNotNullOrEmpty()]
        [string] $TableName,

        [Parameter()]
        [ValidateRange(1, 10000)]
        [int] $BatchSize = 500,

        [Parameter()]
        [ValidateSet('csv', 'json', 'parquet')]
        [string] $Format = 'json',

        [Parameter()]
        [switch] $Force
    )

    begin {
        Write-Verbose "Export starting — format: $Format, batch: $BatchSize"
        $exportedCount = 0
    }

    process {
        if ($PSCmdlet.ShouldProcess($TableName, 'Export')) {
            try {
                # ... core logic ...
                $exportedCount++
                Write-Verbose "Exported: $TableName"
            }
            catch {
                Write-Error "Failed exporting '$TableName': $_"
            }
        }
    }

    end {
        Write-Verbose "Done. Total exported: $exportedCount"
    }
}
```

**Rules:**
- `begin` / `process` / `end` blocks are mandatory when accepting pipeline input.
- `begin` = one-time setup (open connections, initialize accumulators).
- `process` = per-object work. `$_` or named pipeline param holds current object.
- `end` = cleanup, summary output.
- Never `Write-Host` in a library function — use `Write-Verbose`, `Write-Warning`, `Write-Error`.

### 2.2 Output — Only Return What You Mean To

PowerShell's implicit return (every unassigned expression goes to the pipeline) is a common bug
source. Suppress noise explicitly:

```powershell
$null = New-Item -Path $path -Force            # discard New-Item output
[void](Add-Member -InputObject $obj ...)       # discard Add-Member
$list.Add($item) | Out-Null                    # discard List<T>.Add return
```

Return structured objects from functions, never raw strings:

```powershell
function Get-ServiceStatus {
    param([string]$Name)
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    [PSCustomObject]@{
        Name    = $Name
        Status  = $svc?.Status ?? 'NotFound'
        StartType = $svc?.StartType ?? 'N/A'
        Pid     = $svc?.ServiceHandle
    }
}
```

### 2.3 Module Structure

```
MyModule/
├── MyModule.psd1          # Manifest
├── MyModule.psm1          # Root module (dot-sources internals)
├── Public/
│   ├── Get-Thing.ps1
│   └── Set-Thing.ps1
├── Private/
│   ├── Invoke-InternalHelper.ps1
│   └── ConvertTo-InternalFormat.ps1
└── tests/
    ├── Get-Thing.Tests.ps1
    └── Set-Thing.Tests.ps1
```

Root `.psm1` pattern:

```powershell
# MyModule.psm1
$publicFunctions  = Get-ChildItem "$PSScriptRoot/Public"  -Filter '*.ps1'
$privateFunctions = Get-ChildItem "$PSScriptRoot/Private" -Filter '*.ps1'

foreach ($file in @($privateFunctions + $publicFunctions)) {
    . $file.FullName
}

Export-ModuleMember -Function $publicFunctions.BaseName
```

Manifest `.psd1` critical fields:

```powershell
@{
    ModuleVersion     = '1.2.0'
    GUID              = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
    Author            = 'Team Name'
    RootModule        = 'MyModule.psm1'
    FunctionsToExport = @('Get-Thing', 'Set-Thing')
    RequiredModules   = @('Az.Accounts')
    PowerShellVersion = '7.2'
}
```

---

## 3. Error Handling

### 3.1 Try / Catch / Finally

```powershell
try {
    $result = Invoke-RestMethod -Uri $endpoint -Method Post -Body $payload
}
catch [System.Net.Http.HttpRequestException] {
    Write-Error "Network error calling $endpoint : $_"
    throw   # re-throw if caller should handle it
}
catch [System.UnauthorizedAccessException] {
    Write-Error "Access denied: $_"
}
catch {
    # catch-all — always log the full exception
    Write-Error "Unexpected error: $($_.Exception.GetType().FullName) — $($_.Exception.Message)"
    Write-Verbose $_.ScriptStackTrace
    throw
}
finally {
    # always runs — use for cleanup (close streams, remove temp files)
    if ($stream) { $stream.Dispose() }
}
```

### 3.2 $? and $LASTEXITCODE for Native Commands

```powershell
git commit -m "fix: typo"
if ($LASTEXITCODE -ne 0) {
    throw "git commit failed with exit code $LASTEXITCODE"
}
```

When `$ErrorActionPreference = 'Stop'` is set, cmdlet errors throw. But **native executables**
(git, node, python) never do — always check `$LASTEXITCODE`.

### 3.3 ErrorRecord Inspection

```powershell
catch {
    $err = $_
    [PSCustomObject]@{
        Message    = $err.Exception.Message
        Type       = $err.Exception.GetType().FullName
        ScriptLine = $err.InvocationInfo.ScriptLineNumber
        Position   = $err.InvocationInfo.PositionMessage
        Stack      = $err.ScriptStackTrace
    } | ConvertTo-Json
}
```

---

## 4. Pipeline Mastery

### 4.1 Pipeline vs ForEach-Object

Use the pipeline when transforming a stream. Use `foreach` (statement) when you need early exit,
index tracking, or performance on large arrays.

```powershell
# Pipeline — elegant, memory-efficient for large streams
Get-ChildItem -Recurse -Filter '*.log' |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
    Select-Object FullName, LastWriteTime, Length |
    Sort-Object Length -Descending |
    Export-Csv -Path 'old-logs.csv' -NoTypeInformation

# foreach statement — when you need index or break
$files = Get-ChildItem -Recurse -Filter '*.log'
for ($i = 0; $i -lt $files.Count; $i++) {
    Write-Progress -Activity 'Processing' -PercentComplete (($i / $files.Count) * 100)
    if ($files[$i].Length -gt 1GB) { break }
}
```

### 4.2 Parallel Pipelines (PowerShell 7+)

```powershell
$servers = @('web-01', 'web-02', 'web-03', 'db-01')

$results = $servers | ForEach-Object -Parallel {
    $server = $_
    try {
        $ping = Test-Connection -ComputerName $server -Count 1 -Quiet
        [PSCustomObject]@{ Server = $server; Online = $ping; Error = $null }
    }
    catch {
        [PSCustomObject]@{ Server = $server; Online = $false; Error = $_.Exception.Message }
    }
} -ThrottleLimit 10

$results | Format-Table -AutoSize
```

**Parallel gotchas:**
- Variables from the outer scope are NOT automatically available. Pass them via `$using:varName`.
- Modules are NOT auto-imported in parallel runspaces. Add `-AsJob` or import explicitly inside the block.

```powershell
$threshold = 100MB
Get-ChildItem -Recurse | ForEach-Object -Parallel {
    $t = $using:threshold   # inject outer variable
    if ($_.Length -gt $t) { $_.FullName }
} -ThrottleLimit 8
```

### 4.3 Custom Formatters and Select-Object

```powershell
# Computed properties
Get-Process | Select-Object Name,
    @{ Name = 'CPU (s)';  Expression = { [math]::Round($_.CPU, 2) } },
    @{ Name = 'Mem (MB)'; Expression = { [math]::Round($_.WorkingSet / 1MB, 1) } } |
    Sort-Object 'CPU (s)' -Descending |
    Select-Object -First 10
```

---

## 5. File System Operations

### 5.1 Paths — Cross-Platform Safety

Always use `Join-Path` or `[System.IO.Path]::Combine()`. Never concatenate with `\` or `/`.

```powershell
$configPath = Join-Path $PSScriptRoot 'config' 'settings.json'
$logFile    = Join-Path ([System.IO.Path]::GetTempPath()) "run-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
```

### 5.2 Reading and Writing

```powershell
# JSON (preferred for structured data)
$config = Get-Content $configPath -Raw | ConvertFrom-Json
$config.Version = '2.0'
$config | ConvertTo-Json -Depth 10 | Set-Content $configPath -Encoding utf8

# CSV
$data = Import-Csv -Path 'input.csv' -Encoding UTF8
$data | Export-Csv -Path 'output.csv' -NoTypeInformation -Encoding UTF8

# Line-by-line (large files — streaming, low memory)
$reader = [System.IO.StreamReader]::new($largePath)
try {
    while (-not $reader.EndOfStream) {
        $line = $reader.ReadLine()
        # process $line
    }
}
finally { $reader.Dispose() }

# Write with StreamWriter
$writer = [System.IO.StreamWriter]::new($outPath, $false, [System.Text.Encoding]::UTF8)
try {
    foreach ($record in $records) { $writer.WriteLine($record) }
}
finally { $writer.Dispose() }
```

### 5.3 Temp Files and Cleanup

```powershell
$tmp = [System.IO.Path]::GetTempFileName()
try {
    # use $tmp
}
finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
}
```

### 5.4 Watching a Directory

```powershell
$watcher = [System.IO.FileSystemWatcher]@{
    Path   = 'C:\Drops'
    Filter = '*.json'
    EnableRaisingEvents = $true
}

Register-ObjectEvent $watcher Created -Action {
    $file = $Event.SourceEventArgs.FullPath
    Write-Host "New file: $file"
    # process file
}

# Block until Ctrl+C
while ($true) { Start-Sleep 1 }
```

---

## 6. HTTP and REST APIs

### 6.1 Invoke-RestMethod Patterns

```powershell
# GET with headers and query params
$headers = @{
    Authorization = "Bearer $token"
    Accept        = 'application/json'
}

$response = Invoke-RestMethod `
    -Uri    'https://api.example.com/v1/users' `
    -Method Get `
    -Headers $headers `
    -ErrorAction Stop

# POST with JSON body
$payload = @{
    name  = 'Alice'
    email = 'alice@example.com'
} | ConvertTo-Json

$created = Invoke-RestMethod `
    -Uri         'https://api.example.com/v1/users' `
    -Method      Post `
    -Headers     $headers `
    -Body        $payload `
    -ContentType 'application/json'

# PATCH
$patch = @{ status = 'active' } | ConvertTo-Json
Invoke-RestMethod -Uri "https://api.example.com/v1/users/$id" -Method Patch `
    -Headers $headers -Body $patch -ContentType 'application/json'
```

### 6.2 Pagination

```powershell
function Get-AllPages {
    param([string]$BaseUri, [hashtable]$Headers)

    $page    = 1
    $results = [System.Collections.Generic.List[object]]::new()

    do {
        $response = Invoke-RestMethod `
            -Uri     "${BaseUri}?page=${page}&per_page=100" `
            -Headers $Headers
        $results.AddRange($response.items)
        $page++
        Write-Verbose "Fetched page $($page - 1), total so far: $($results.Count)"
    } while ($response.items.Count -eq 100)

    $results
}
```

### 6.3 Retry with Exponential Backoff

```powershell
function Invoke-WithRetry {
    param(
        [scriptblock] $Action,
        [int]         $MaxAttempts = 5,
        [int]         $BaseDelayMs = 500
    )

    $attempt = 0
    do {
        try {
            return & $Action
        }
        catch {
            $attempt++
            if ($attempt -ge $MaxAttempts) { throw }
            $delay = $BaseDelayMs * [math]::Pow(2, $attempt - 1)
            Write-Warning "Attempt $attempt failed. Retrying in ${delay}ms..."
            Start-Sleep -Milliseconds $delay
        }
    } while ($attempt -lt $MaxAttempts)
}

# Usage
$data = Invoke-WithRetry -Action {
    Invoke-RestMethod -Uri $endpoint -Headers $headers
} -MaxAttempts 5
```

### 6.4 File Upload (multipart/form-data)

```powershell
$filePath = 'report.pdf'
$boundary = [System.Guid]::NewGuid().ToString()
$fileBytes = [System.IO.File]::ReadAllBytes($filePath)
$fileName  = [System.IO.Path]::GetFileName($filePath)

$bodyLines = @(
    "--$boundary",
    "Content-Disposition: form-data; name=`"file`"; filename=`"$fileName`"",
    "Content-Type: application/octet-stream",
    "",
    [System.Text.Encoding]::GetEncoding('iso-8859-1').GetString($fileBytes),
    "--$boundary--"
)

Invoke-RestMethod -Uri $uploadEndpoint -Method Post `
    -ContentType "multipart/form-data; boundary=$boundary" `
    -Body ($bodyLines -join "`r`n")
```

---

## 7. Credentials and Secrets

**Never hardcode secrets.** Use this priority order:

1. Environment variables (`$env:MY_SECRET`)
2. SecretManagement module (`Get-Secret`)
3. Azure Key Vault / AWS Secrets Manager via SDK
4. Encrypted XML (`Export-Clixml` / `Import-Clixml`) — Windows only, user-scoped

```powershell
# SecretManagement (preferred cross-platform)
Import-Module Microsoft.PowerShell.SecretManagement
$token = Get-Secret -Name 'API_TOKEN' -AsPlainText

# Environment variable fallback
$token = $env:API_TOKEN
if (-not $token) { throw 'API_TOKEN environment variable is not set.' }

# PSCredential for username+password
$cred = Get-Credential -Message 'Enter DB credentials'
$plainPass = $cred.GetNetworkCredential().Password

# Encrypted file (Windows, current user only — NOT for CI)
$cred | Export-Clixml -Path "$env:APPDATA\mycred.xml"
$cred = Import-Clixml -Path "$env:APPDATA\mycred.xml"
```

---

## 8. Processes and System

### 8.1 Start and Wait

```powershell
# Capture output
$result = & node build.js 2>&1
if ($LASTEXITCODE -ne 0) { throw "Build failed: $result" }

# Background job
$job = Start-Job -ScriptBlock {
    param($path)
    Get-ChildItem $path -Recurse | Measure-Object -Property Length -Sum
} -ArgumentList 'C:\Data'

$output = Receive-Job $job -Wait -AutoRemoveJob
Write-Host "Total size: $($output.Sum / 1GB) GB"

# Start-Process with redirection
$proc = Start-Process -FilePath 'python' `
    -ArgumentList 'script.py', '--input', 'data.csv' `
    -RedirectStandardOutput 'out.txt' `
    -RedirectStandardError  'err.txt' `
    -NoNewWindow -Wait -PassThru

if ($proc.ExitCode -ne 0) {
    throw "Python failed:`n$(Get-Content err.txt)"
}
```

### 8.2 Registry

```powershell
# Read
$val = Get-ItemPropertyValue -Path 'HKLM:\SOFTWARE\MyApp' -Name 'InstallPath'

# Write (requires elevation)
Set-ItemProperty -Path 'HKCU:\SOFTWARE\MyApp' -Name 'Theme' -Value 'Dark'

# Create key
New-Item -Path 'HKCU:\SOFTWARE\MyApp\Settings' -Force | Out-Null

# Delete value
Remove-ItemProperty -Path 'HKCU:\SOFTWARE\MyApp' -Name 'OldSetting' -ErrorAction SilentlyContinue

# Enumerate subkeys
Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' |
    ForEach-Object { Get-ItemProperty $_.PSPath } |
    Where-Object { $_.DisplayName } |
    Select-Object DisplayName, DisplayVersion, Publisher |
    Sort-Object DisplayName
```

### 8.3 Services and Scheduled Tasks

```powershell
# Service control
Get-Service -Name 'wuauserv' | Set-Service -StartupType Disabled
Restart-Service -Name 'Spooler' -Force

# Scheduled task
$action  = New-ScheduledTaskAction -Execute 'pwsh.exe' -Argument '-File C:\Scripts\cleanup.ps1'
$trigger = New-ScheduledTaskTrigger -Daily -At '02:00'
$settings = New-ScheduledTaskSettingsSet -RunOnlyIfNetworkAvailable -WakeToRun
Register-ScheduledTask -TaskName 'NightlyCleanup' -Action $action -Trigger $trigger `
    -Settings $settings -RunLevel Highest -Force
```

---

## 9. Data Transformation

### 9.1 Group, Sort, Aggregate

```powershell
$logs = Import-Csv 'events.csv'

# Group and count
$logs | Group-Object -Property Level | Select-Object Name, Count | Sort-Object Count -Descending

# Aggregate with calculated properties
$logs |
    Where-Object { $_.Level -eq 'ERROR' } |
    Group-Object -Property Service |
    Select-Object Name,
        @{ Name = 'ErrorCount'; Expression = { $_.Count } },
        @{ Name = 'Latest';     Expression = { ($_.Group | Sort-Object Timestamp -Descending | Select-Object -First 1).Timestamp } } |
    Sort-Object ErrorCount -Descending
```

### 9.2 Hashtable Lookups (fast joins)

For large datasets, never do nested loops — build a hashtable index first:

```powershell
# Build O(1) index
$userIndex = @{}
Import-Csv 'users.csv' | ForEach-Object { $userIndex[$_.Id] = $_ }

# Join O(n) instead of O(n²)
Import-Csv 'orders.csv' | ForEach-Object {
    $user = $userIndex[$_.UserId]
    [PSCustomObject]@{
        OrderId  = $_.Id
        Amount   = $_.Amount
        UserName = $user?.Name ?? 'Unknown'
        Email    = $user?.Email ?? 'N/A'
    }
} | Export-Csv 'orders-enriched.csv' -NoTypeInformation
```

### 9.3 JSON Depth and Schema

```powershell
# Deep conversion — default depth is 2, always override
$json = $object | ConvertTo-Json -Depth 20 -Compress

# Validate a required field exists
$data = $json | ConvertFrom-Json
if (-not $data.PSObject.Properties['requiredField']) {
    throw "JSON missing required field 'requiredField'"
}
```

---

## 10. Testing with Pester

Every non-trivial function should have a Pester test. Minimum: happy path + one error path.

```powershell
# Get-ServiceStatus.Tests.ps1
BeforeAll {
    . "$PSScriptRoot/../Public/Get-ServiceStatus.ps1"
}

Describe 'Get-ServiceStatus' {
    Context 'when service exists' {
        It 'returns a PSCustomObject with Name and Status' {
            Mock Get-Service { [PSCustomObject]@{ Status = 'Running'; StartType = 'Automatic' } }
            $result = Get-ServiceStatus -Name 'FakeSvc'
            $result.Name   | Should -Be 'FakeSvc'
            $result.Status | Should -Be 'Running'
        }
    }

    Context 'when service does not exist' {
        It 'returns NotFound status' {
            Mock Get-Service { $null }
            $result = Get-ServiceStatus -Name 'GhostSvc'
            $result.Status | Should -Be 'NotFound'
        }
    }
}
```

Run all tests:

```powershell
Invoke-Pester -Path './tests' -Output Detailed -CI
```

---

## 11. Logging Pattern

Use a consistent logger. Never scatter `Write-Host` across production scripts.

```powershell
enum LogLevel { DEBUG; INFO; WARN; ERROR }

function Write-Log {
    param(
        [Parameter(Mandatory)] [string]   $Message,
        [LogLevel]                         $Level   = [LogLevel]::INFO,
        [string]                           $LogFile = $script:LogPath
    )

    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'
    $entry     = "[$timestamp] [$Level] $Message"

    switch ($Level) {
        'DEBUG' { Write-Debug   $Message }
        'INFO'  { Write-Verbose $Message }
        'WARN'  { Write-Warning $Message }
        'ERROR' { Write-Error   $Message }
    }

    if ($LogFile) {
        Add-Content -Path $LogFile -Value $entry -Encoding UTF8
    }
}

# Usage
$script:LogPath = Join-Path $PSScriptRoot "logs\run-$(Get-Date -Format 'yyyyMMdd').log"
Write-Log 'Export started'          -Level INFO
Write-Log "Processing $count items" -Level DEBUG
Write-Log 'Disk space low'          -Level WARN
Write-Log "DB connection failed: $_" -Level ERROR
```

---

## 12. Cross-Platform (pwsh 7) Considerations

| Task                  | Windows 5.1         | pwsh 7+ (cross)               |
|-----------------------|---------------------|-------------------------------|
| Path separator        | `\`                 | Use `Join-Path` always        |
| Temp dir              | `$env:TEMP`         | `[IO.Path]::GetTempPath()`    |
| Home dir              | `$env:USERPROFILE`  | `$HOME`                       |
| User data dir         | `$env:APPDATA`      | `$HOME/.config`               |
| Elevation check       | `IsInRole`          | Platform guard + `IsInRole`   |
| Credential store      | `Export-Clixml`     | SecretManagement module       |

```powershell
# Platform guard
if ($IsWindows) {
    # Windows-only code
}
elseif ($IsLinux) {
    # Linux-only code
}
elseif ($IsMacOS) {
    # macOS-only code
}

# Elevation check (cross-platform)
function Test-IsElevated {
    if ($IsWindows) {
        ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    else {
        (id -u) -eq 0
    }
}
```

---

## 13. Performance Anti-Patterns

| Anti-Pattern                          | Fix                                              |
|---------------------------------------|--------------------------------------------------|
| `+=` on arrays in a loop              | Use `[List[T]]` or collect with `foreach`        |
| Nested `Where-Object` on large sets   | Build hashtable index                            |
| `Get-Content` on huge files           | `StreamReader`                                   |
| `Invoke-Expression` with user input   | Never. Parameterize properly.                    |
| `Write-Host` in library functions     | `Write-Verbose` / `Write-Warning`                |
| Not disposing .NET objects            | `try/finally` with `.Dispose()`                  |
| `Select-Object *` over the pipeline   | Select only needed properties early              |
| Calling cmdlets in tight inner loops  | Batch with `-InputObject` or native .NET methods |

```powershell
# BAD — O(n) array copies
$result = @()
foreach ($i in 1..10000) { $result += $i }

# GOOD — O(1) amortized append
$result = [System.Collections.Generic.List[int]]::new()
foreach ($i in 1..10000) { $result.Add($i) }

# BEST — let PowerShell collect (no explicit list needed)
$result = foreach ($i in 1..10000) { $i }
```

---

## 14. Security Checklist

Before shipping any script:

- [ ] No hardcoded credentials, tokens, connection strings
- [ ] `Set-StrictMode -Version Latest` at top
- [ ] `$ErrorActionPreference = 'Stop'` or explicit `-ErrorAction` on every cmdlet
- [ ] `$LASTEXITCODE` checked after every native command
- [ ] No `Invoke-Expression` with user-controlled or external input
- [ ] `SupportsShouldProcess` on any function that mutates state
- [ ] File paths built with `Join-Path`, never string concat
- [ ] Sensitive output suppressed (no logging of passwords/tokens)
- [ ] `.Dispose()` called in `finally` for any stream/connection
- [ ] Minimum required permissions (don't require admin if you don't need it)

---

## 15. Quick Reference — Idioms

```powershell
# Null coalescing (PS 7+)
$value = $config.Timeout ?? 30

# Ternary (PS 7+)
$label = $isActive ? 'Active' : 'Inactive'

# Null conditional member access (PS 7+)
$city = $user?.Address?.City

# Pipeline chain operators (PS 7+)
git pull && npm install && npm run build
Start-Service 'MyService' || Write-Warning 'Service failed to start'

# Splatting — for long parameter lists
$params = @{
    Path        = $dest
    Recurse     = $true
    Force       = $true
    ErrorAction = 'Stop'
}
Copy-Item @params

# Measure execution time
$elapsed = Measure-Command {
    # ... code to time ...
}
Write-Verbose "Completed in $($elapsed.TotalSeconds)s"

# Confirm a destructive action interactively
if ($PSCmdlet.ShouldProcess($target, 'Delete permanently')) { Remove-Item $target -Recurse -Force }

# Check if running in CI
$inCI = $env:CI -eq 'true' -or $env:TF_BUILD -eq 'True' -or $env:GITHUB_ACTIONS -eq 'true'
```

---

## Behavioral Rules for the Agent

1. **Always output objects, not text.** Functions must return `[PSCustomObject]` or typed objects.
2. **Match the PowerShell version.** If the user mentions Windows PowerShell or 5.1, avoid 7-only syntax. If they mention `pwsh` or cross-platform, default to 7.2+.
3. **Respect `ShouldProcess`.** Any function that creates, modifies, or deletes things gets `SupportsShouldProcess` — no exceptions.
4. **Prefer pipeline-compatible designs.** Functions taking a collection parameter should accept `ValueFromPipeline`.
5. **Never use `Write-Host` in reusable code.** Only in terminal-only scripts where the sole audience is a human in that session.
6. **Handle `$LASTEXITCODE`.** After every native command call, check it.
7. **Pester for anything non-trivial.** If the function has branches, it has tests.
8. **Splatting over backtick line continuation.** Backticks are fragile (invisible trailing space = syntax error).
9. **`-Encoding UTF8` everywhere.** Default encoding varies by platform — never rely on it.
10. **No `Invoke-Expression` on external data.** Ever.