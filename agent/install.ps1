# Pocket Terminal: Windows installer. Safe to run again any time.
# Run in PowerShell (no admin needed):
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
#   1. installs the agent's packages
#   2. allows wake-up alarms so the PC can check in while asleep
#   3. starts the agent now and at every sign-in (hidden, restarts itself if it crashes)
#   4. shows a QR code: scan it with your phone to pair
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$Dir = Join-Path $HOME '.pocket-terminal'
function Step($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host 'Install Node.js 18.20+ (LTS) from https://nodejs.org, then run this again.'; exit 1 }
& $node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>18||(a===18&&b>=20)?0:1)"
if ($LASTEXITCODE) { Write-Host "Your Node.js is too old ($(& $node -v)). Install the LTS from https://nodejs.org"; exit 1 }
New-Item -ItemType Directory -Force $Dir | Out-Null

Step '1/4' 'Installing packages'
npm ci --omit=dev --no-fund --no-audit --loglevel=error
if ($LASTEXITCODE) { Write-Host 'npm ci failed. See the messages above.'; exit 1 }

Step '2/4' 'Power settings'
# Let scheduled wake-ups wake the PC (on battery and plugged in).
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 | Out-Null
powercfg /setdcvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 | Out-Null
powercfg /setactive SCHEME_CURRENT | Out-Null
if ((powercfg /a | Out-String) -match 'S0 Low Power Idle') {
  Write-Host 'Note: this PC uses "Modern Standby". Wake-up check-ins on battery may not work on it.' -ForegroundColor Yellow
  Write-Host '      Plugged in it works instantly. On battery, use Instant mode (phone app: Power tab).' -ForegroundColor Yellow
}
Write-Host 'Power settings ready.'

Step '3/4' 'Pairing key'
# The original repo uses the official app (utsavdoye20122005.github.io/pocket-terminal).
# If you forked it, your phone app lives on YOUR GitHub Pages. Use it automatically.
$appArgs = @()
$origin = ''
try { $origin = (git -C (Split-Path $PSScriptRoot) remote get-url origin 2>$null) } catch {}
if ($origin -match 'github\.com[:/]([^/]+)/([^/.]+)' -and $origin -notmatch 'utsavdoye20122005/pocket-terminal') { $appArgs = @('--app-url', "https://$($Matches[1].ToLower()).github.io/$($Matches[2])/") }
& $node pair.js --list @appArgs | Out-Null

Step '4/4' 'Starting the agent now and at every sign-in'
$log = Join-Path $Dir 'agent.log'
$vbs = Join-Path $Dir 'start-agent.vbs'
# A tiny launcher: runs the agent with no window, and starts it again if it ever stops.
@"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$PSScriptRoot"
Do
  sh.Run "cmd /c """"$node"" ""$PSScriptRoot\agent.js"" >> ""$log"" 2>&1""", 0, True
  WScript.Sleep 5000
Loop
"@ | Set-Content -Encoding ASCII $vbs

# Stop an older copy if one is running.
Get-CimInstance Win32_Process -Filter "Name='wscript.exe' OR Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*start-agent.vbs*' -or $_.CommandLine -like "*$PSScriptRoot*agent.js*" } |
  ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'PocketTerminalAgent' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'PocketTerminalAgent'
Start-Sleep -Seconds 4
if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'mailbox ready' -Quiet)) { Write-Host 'Agent running.' -ForegroundColor Green }
else { Write-Host "Agent started. If something's off, see: $log" }

Write-Host ''
& $node pair.js
