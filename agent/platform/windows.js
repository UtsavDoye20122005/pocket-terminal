// Windows power controls (all built into Windows, no admin needed for these):
//   Win32_Battery (CIM)                 battery level and charger state
//   GetLastInputInfo                    how long since anyone touched the keyboard/mouse
//   powercfg … SUB_BUTTONS LIDACTION    what closing the lid does (0 = do nothing, 1 = sleep)
//   SetThreadExecutionState             "don't idle-sleep while this runs"
//   Task Scheduler "wake to run" task   alarm clock that wakes a sleeping PC
//   SetSuspendState('Suspend')          go to sleep right now
//
// Windows can't tell an app whether the lid is closed, so "lid closed" here means
// "nobody has used this PC for 10 minutes". The power brain only ever forces sleep then.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const run = require('./run');

const PS = 'powershell.exe';
const ps = (script, timeout) => run(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], timeout);
const DIR = process.env.POCKET_HOME || path.join(os.homedir(), '.pocket-terminal');
const LID_FILE = path.join(DIR, 'windows-lid.json');
const TASK = 'PocketTerminalWake';
const AWAY_SECONDS = 10 * 60;

// One PowerShell call reads battery + idle time; cached for 20 s (PowerShell is slow to start).
const PROBE = `
$b = Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class PtIdle {
  [StructLayout(LayoutKind.Sequential)] public struct L { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref L l);
  public static uint Seconds() { L l = new L(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return ((uint)Environment.TickCount - l.dwTime) / 1000; }
}
'@
@{ percent = $b.EstimatedChargeRemaining; status = $b.BatteryStatus; idle = [PtIdle]::Seconds() } | ConvertTo-Json -Compress`;

// BatteryStatus: 1 discharging, 4 low, 5 critical → on battery. Everything else → plugged in.
function parseProbe(text) {
  let j = {}; try { j = JSON.parse(String(text).trim() || '{}'); } catch {}
  const hasBattery = j.status !== null && j.status !== undefined;
  return {
    percent: hasBattery && Number.isFinite(j.percent) ? j.percent : null,
    onCharger: !hasBattery || ![1, 4, 5].includes(Number(j.status)),
    state: hasBattery ? `status ${j.status}` : 'no battery (desktop)',
    idleSeconds: Number.isFinite(j.idle) ? j.idle : 0,
  };
}

// "Current AC Power Setting Index: 0x00000001"  →  { ac: 1, dc: 1 }
function parseLidAction(text) {
  const ac = /Current AC Power Setting Index:\s*0x([0-9a-f]+)/i.exec(text);
  const dc = /Current DC Power Setting Index:\s*0x([0-9a-f]+)/i.exec(text);
  return { ac: ac ? parseInt(ac[1], 16) : 1, dc: dc ? parseInt(dc[1], 16) : 1 };
}

// Local time in the format Task Scheduler accepts.
function taskTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

let cache = null, cacheAt = 0;
async function probe() {
  if (cache && Date.now() - cacheAt < 20e3) return cache;
  const r = await ps(PROBE, 20e3);
  cache = parseProbe(r.out); cacheAt = Date.now();
  return cache;
}

async function originalLid() {
  try { return JSON.parse(fs.readFileSync(LID_FILE, 'utf8')); } catch {}
  const r = await run('powercfg', ['/q', 'SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION']);
  const orig = parseLidAction(r.out);
  // Never save "do nothing" as the original if we (or a crash) left it that way.
  if (orig.ac === 0 && orig.dc === 0) { orig.ac = 1; orig.dc = 1; }
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(LID_FILE, JSON.stringify(orig)); } catch {}
  return orig;
}
async function setLid(ac, dc) {
  await run('powercfg', ['/setacvalueindex', 'SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION', String(ac)]);
  await run('powercfg', ['/setdcvalueindex', 'SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION', String(dc)]);
  return run('powercfg', ['/setactive', 'SCHEME_CURRENT']);
}

// A tiny hidden PowerShell that holds "system required" until we kill it.
let holder = null;
function holdAwake(on) {
  if (on && !holder) {
    holder = spawn(PS, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
      "Add-Type -Name E -Namespace Pt -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'; " +
      '[Pt.E]::SetThreadExecutionState(0x80000001) | Out-Null; while ($true) { Start-Sleep -Seconds 3600 }'],
    { windowsHide: true, stdio: 'ignore' });
    holder.on('exit', () => { holder = null; });
  } else if (!on && holder) { holder.kill(); holder = null; }
}

const sys = {
  name: 'Windows',
  battery: async () => { const p = await probe(); return { percent: p.percent, onCharger: p.onCharger, state: p.state }; },
  lidClosed: async () => (await probe()).idleSeconds >= AWAY_SECONDS,
  setNoSleep: async (on) => {
    const orig = await originalLid();
    holdAwake(on);
    return on ? setLid(0, 0) : setLid(orig.ac, orig.dc);
  },
  scheduleWake: async (date) => ps(
    `$t = New-ScheduledTaskTrigger -Once -At ([datetime]'${taskTime(date)}'); ` +
    '$s = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; ' +
    "$a = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c exit'; " +
    `Register-ScheduledTask -TaskName '${TASK}' -Trigger $t -Settings $s -Action $a -Force | Out-Null`),
  cancelWake: async () => ps(`Unregister-ScheduledTask -TaskName '${TASK}' -Confirm:$false -ErrorAction SilentlyContinue`),
  sleepNow: async () => { cache = null; return ps("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false) | Out-Null"); },
};

module.exports = { sys, parseProbe, parseLidAction, taskTime };
