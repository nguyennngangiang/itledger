<#
    register-task.ps1 — creates the ITLedger-AutoStart scheduled task, which runs
    start-itledger.ps1 to bring the stack up and keep it up.

    TWO MODES, because the good one needs an administrator:

    A) Unattended after reboot (default) — REQUIRES AN ELEVATED SHELL.
           powershell -ExecutionPolicy Bypass -File deploy\register-task.ps1
       Triggers AtStartup with a stored password, so the stack returns after a
       reboot with nobody logged in. Only an administrator can create a task that
       runs "whether the user is logged on or not".

    B) Fallback, no admin needed:
           powershell -ExecutionPolicy Bypass -File deploy\register-task.ps1 -LogonOnly
       Triggers at logon instead — same as the neighbouring LLM-AutoStart task.
       The stack comes up once someone logs into the IT account, NOT at boot.

    -TaskUser defaults to the account that owns the WSL distro, and you almost
    certainly should not change it. See the comment on the parameter.
#>
[CmdletBinding()]
param(
    # The task must run as the account whose profile has the Ubuntu-24.04 WSL
    # distro registered — WSL distros are PER USER. If an administrator registers
    # this task under their own name instead, wsl.exe finds no such distro, docker
    # never starts, and the failure looks like a mysterious dead API. So this stays
    # pinned to IT even when a different account runs the script.
    [string]$TaskUser = 'IT-SERVER\IT',

    # Register an at-logon task instead of at-startup. No admin, no password, but
    # the stack then waits for someone to log in after a reboot.
    [switch]$LogonOnly
)
$ErrorActionPreference = 'Stop'

$taskName = 'ITLedger-AutoStart'
$script   = Join-Path $PSScriptRoot 'start-itledger.ps1'
if (-not (Test-Path $script)) { throw "Cannot find $script" }

$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
            ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $LogonOnly -and -not $elevated) {
    throw @"
Not running elevated, so an AtStartup task cannot be created.

  * Preferred: re-run this in an ELEVATED PowerShell (an admin account). The task
    will still be registered to run as $TaskUser, which is what matters.
  * Or, for now, run without admin and accept that the stack needs a login:
        powershell -ExecutionPolicy Bypass -File "$PSCommandPath" -LogonOnly
"@
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""

# -Once + RepetitionInterval is how you express "every N minutes, forever". The
# watchdog matters more than the boot trigger in day-to-day use: start-itledger.ps1
# is idempotent, so each tick is a no-op when healthy and a repair when not.
# No -RepetitionDuration on purpose: an omitted duration IS how Task Scheduler
# spells "repeat indefinitely". Don't "improve" this by passing
# [TimeSpan]::MaxValue — that serializes to P99999999DT23H59M59S and the task XML
# is rejected outright ("value which is incorrectly formatted or out of range").
# The registered trigger shows a blank Duration with StopAtDurationEnd=True, which
# looks wrong but is correct: StopAtDurationEnd is ignored when there is no duration.
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)

# A finite execution limit is deliberate. With MultipleInstances=IgnoreNew, one
# wedged run would block every later watchdog tick forever; an hour is far more
# than a cold start needs (worst case ~2 min of pip install), so anything alive at
# that point is stuck and better killed.
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Write-Host "Replacing the existing '$taskName'..."
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$common = @{
    TaskName    = $taskName
    Action      = $action
    Settings    = $settings
    Description = 'IT Ledger: WSL/docker stack + e5-small embedder + Caddy :10000 (LAN deployment)'
}

if ($LogonOnly) {
    Write-Host "Mode   : at logon (no admin, no stored password)" -ForegroundColor Yellow
    Write-Host "Run as : $TaskUser"
    Write-Host "NOTE   : after a reboot the stack waits for someone to log in." -ForegroundColor Yellow
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $TaskUser
    # RunLevel stays Limited: $TaskUser is not an administrator, and nothing in
    # start-itledger.ps1 needs elevation (wsl.exe, docker via wsl, Start-Process).
    $principal = New-ScheduledTaskPrincipal -UserId $TaskUser -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask @common -Trigger $trigger, $watchdog -Principal $principal | Out-Null
} else {
    Write-Host "Mode   : at startup, whether or not anyone is logged on" -ForegroundColor Green
    Write-Host "Run as : $TaskUser"
    Write-Host ""
    Write-Host "Windows stores this password so the task can run with no active session." -ForegroundColor Yellow
    Write-Host "Enter the password for $TaskUser (NOT the admin account you elevated with)." -ForegroundColor Yellow
    $secure = Read-Host "Password for $TaskUser" -AsSecureString
    $bstr   = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $plain  = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    if (-not $plain) { throw "No password entered - aborting." }

    try {
        $atStartup = New-ScheduledTaskTrigger -AtStartup
        Register-ScheduledTask @common -Trigger $atStartup, $watchdog `
            -User $TaskUser -Password $plain -RunLevel Limited | Out-Null
    } catch {
        throw @"
Registration failed: $($_.Exception.Message)

If this is a logon failure, $TaskUser is missing the "Log on as a batch job" right.
Grant it in secpol.msc -> Local Policies -> User Rights Assignment ->
"Log on as a batch job" -> add $TaskUser, then re-run this script.
"@
    } finally {
        $plain = $null   # don't leave the plaintext password in the session
        [GC]::Collect()
    }
}

Write-Host ""
Write-Host "Registered. Running it now to confirm..." -ForegroundColor Green
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 8
Get-ScheduledTask -TaskName $taskName | Get-ScheduledTaskInfo |
    Select-Object TaskName, LastRunTime, LastTaskResult, NextRunTime | Format-List

Write-Host "LastTaskResult 0 means the action launched cleanly."
Write-Host "Then check what it actually did:  Get-Content deploy\autostart.log -Tail 10"
