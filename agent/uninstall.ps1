# Removes Pocket Terminal from this Windows PC and puts power settings back.
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1          keep the pairing key
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Purge   delete the key too
param([switch]$Purge)
$Dir = Join-Path $HOME '.pocket-terminal'
foreach ($t in 'PocketTerminalAgent', 'PocketTerminalWake') {
  Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -Filter "Name='wscript.exe' OR Name='node.exe' OR Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*start-agent.vbs*' -or $_.CommandLine -like '*pocket-terminal*agent.js*' -or $_.CommandLine -like '*SetThreadExecutionState*' } |
  ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
# Put "what closing the lid does" back to how it was before installing.
$lid = Join-Path $Dir 'windows-lid.json'
$orig = if (Test-Path $lid) { Get-Content $lid | ConvertFrom-Json } else { [pscustomobject]@{ ac = 1; dc = 1 } }
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION $orig.ac | Out-Null
powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION $orig.dc | Out-Null
powercfg /setactive SCHEME_CURRENT | Out-Null
if ($Purge) { Remove-Item -Recurse -Force $Dir -ErrorAction SilentlyContinue; Write-Host 'Pairing key deleted.' }
Write-Host 'Pocket Terminal removed. Lid and sleep settings are back to normal.'
