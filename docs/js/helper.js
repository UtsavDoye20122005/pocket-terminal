// Command helper: find a command when you only half-remember it, or describe what you want in plain English.
//
//  1. Built-in library (offline, free, instant). Searches by meaning ("big files", "who is using port 3000")
//     and by command start ("git sta"). Includes your own past commands and saved commands.
//  2. AI (optional). Your own API key, stored encrypted with your pairing key. The request goes straight
//     from this phone to the AI provider; the computer and the message board never see it.
//
// Nothing ever runs by itself: you always see the command, a plain explanation, and a risk label first.

// u = macOS + Linux, mac = macOS only, lin = Linux only, win = Windows PowerShell. <...> = fill this in.
const LIB = [
  // files and folders
  { n: 'List files with details', k: 'list files folder show directory contents ls dir hidden', u: 'ls -lah', win: 'Get-ChildItem -Force' },
  { n: 'Where am I (current folder)', k: 'current folder directory path pwd where am i', u: 'pwd', win: 'Get-Location' },
  { n: 'Go to a folder', k: 'change folder directory cd go to open', u: 'cd <folder>', win: 'Set-Location <folder>' },
  { n: 'Biggest files in a folder', k: 'big large biggest files size space taking heavy', u: 'du -ah <folder> 2>/dev/null | sort -rh | head -15', win: 'Get-ChildItem <folder> -Recurse -File -EA SilentlyContinue | Sort-Object Length -Desc | Select-Object -First 15 FullName,@{n="MB";e={[math]::Round($_.Length/1MB,1)}}' },
  { n: 'Folder sizes', k: 'folder size how big space used subfolders du', u: 'du -sh <folder>/* 2>/dev/null | sort -rh | head -20', win: 'Get-ChildItem <folder> -Directory | ForEach-Object { [pscustomobject]@{Folder=$_.Name; MB=[math]::Round((Get-ChildItem $_.FullName -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum/1MB,1)} } | Sort-Object MB -Desc' },
  { n: 'Find a file by name', k: 'find search locate file name where is', u: 'find ~ -iname "*<name>*" 2>/dev/null | head -30', mac: 'mdfind -name "<name>" | head -30', win: 'Get-ChildItem ~ -Recurse -Filter "*<name>*" -EA SilentlyContinue | Select-Object -First 30 FullName' },
  { n: 'Search text inside files', k: 'search grep text inside files contains word find string', u: 'grep -rni "<text>" <folder> | head -40', win: 'Select-String -Path <folder>\\* -Pattern "<text>" -Recurse | Select-Object -First 40' },
  { n: 'Files changed recently', k: 'recent recently modified changed today new files latest', u: 'find <folder> -type f -mtime -1 2>/dev/null | head -30', win: 'Get-ChildItem <folder> -Recurse -File | Where-Object LastWriteTime -gt (Get-Date).AddDays(-1) | Select-Object -First 30 FullName' },
  { n: 'Show a file', k: 'show read print view file contents cat open text', u: 'cat <file>', win: 'Get-Content <file>' },
  { n: 'Last lines of a file', k: 'tail last lines end log file', u: 'tail -n 50 <file>', win: 'Get-Content <file> -Tail 50' },
  { n: 'Make a folder', k: 'make create new folder directory mkdir', u: 'mkdir -p <folder>', win: 'New-Item -ItemType Directory -Force <folder>' },
  { n: 'Copy a file or folder', k: 'copy duplicate file folder cp', u: 'cp -R <from> <to>', win: 'Copy-Item <from> <to> -Recurse' },
  { n: 'Move or rename', k: 'move rename file folder mv', u: 'mv <from> <to>', win: 'Move-Item <from> <to>' },
  { n: 'Delete a file', k: 'delete remove erase file rm', u: 'rm <file>', win: 'Remove-Item <file>' },
  { n: 'Zip a folder', k: 'zip compress archive folder', u: 'zip -r <name>.zip <folder>', win: 'Compress-Archive <folder> <name>.zip' },
  { n: 'Unzip', k: 'unzip extract decompress archive', u: 'unzip <file>.zip -d <folder>', win: 'Expand-Archive <file>.zip <folder>' },
  { n: 'Count lines in a file', k: 'count lines words file wc', u: 'wc -l <file>', win: '(Get-Content <file>).Count' },
  { n: 'Open Downloads folder list', k: 'downloads folder what did i download', u: 'ls -lt ~/Downloads | head -20', win: 'Get-ChildItem ~\\Downloads | Sort-Object LastWriteTime -Desc | Select-Object -First 20' },

  // system
  { n: 'Disk space left', k: 'disk space storage free full left how much', u: 'df -h', mac: 'df -h /', win: 'Get-PSDrive -PSProvider FileSystem' },
  { n: 'Battery level', k: 'battery charge percent power level charging', mac: 'pmset -g batt', lin: 'cat /sys/class/power_supply/BAT*/capacity', win: 'Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus' },
  { n: 'What is using CPU', k: 'cpu slow processes heavy top using running hot fan', u: 'ps -Ao pid,%cpu,%mem,comm -r | head -10', lin: 'ps -eo pid,%cpu,%mem,comm --sort=-%cpu | head -10', win: 'Get-Process | Sort-Object CPU -Desc | Select-Object -First 10 Id,ProcessName,CPU' },
  { n: 'What is using memory', k: 'memory ram processes heavy using', u: 'ps -Ao pid,%mem,rss,comm -m | head -10', lin: 'ps -eo pid,%mem,rss,comm --sort=-%mem | head -10', win: 'Get-Process | Sort-Object WS -Desc | Select-Object -First 10 Id,ProcessName,@{n="MB";e={[math]::Round($_.WS/1MB)}}' },
  { n: 'Free memory', k: 'free memory ram available', mac: 'vm_stat | head -6 && sysctl hw.memsize', lin: 'free -h', win: 'Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,TotalVisibleMemorySize' },
  { n: 'Stop a program by name', k: 'kill stop close quit program app process force', u: 'pkill -f "<name>"', win: 'Stop-Process -Name "<name>"' },
  { n: 'Is a program running', k: 'running is process alive check program', u: 'pgrep -fl "<name>"', win: 'Get-Process *<name>*' },
  { n: 'How long it has been on', k: 'uptime how long on running since boot', u: 'uptime', win: '(Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime' },
  { n: 'Computer info', k: 'system info version os macos windows model', mac: 'sw_vers && sysctl -n machdep.cpu.brand_string', lin: 'uname -a && cat /etc/os-release', win: 'Get-ComputerInfo | Select-Object OsName,OsVersion,CsModel' },
  { n: 'Lock the screen', k: 'lock screen', mac: 'pmset displaysleepnow', win: 'rundll32.exe user32.dll,LockWorkStation' },
  { n: 'Put the computer to sleep', k: 'sleep suspend now', mac: 'pmset sleepnow', win: 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0' },
  { n: 'Restart the computer', k: 'restart reboot', mac: 'sudo shutdown -r now', lin: 'sudo reboot', win: 'Restart-Computer' },
  { n: 'Shut down', k: 'shut down shutdown power off turn off', mac: 'sudo shutdown -h now', lin: 'sudo poweroff', win: 'Stop-Computer' },
  { n: 'Set volume', k: 'volume sound mute loud', mac: 'osascript -e "set volume output volume <0-100>"' },
  { n: 'Say something out loud', k: 'say speak talk voice', mac: 'say "<text>"', win: 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak("<text>")' },
  { n: 'Take a screenshot', k: 'screenshot screen capture picture', mac: 'screencapture -x ~/Desktop/shot.png', win: 'Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $i=New-Object System.Drawing.Bitmap $b.Width,$b.Height; [System.Drawing.Graphics]::FromImage($i).CopyFromScreen(0,0,0,0,$i.Size); $i.Save("$HOME\\Desktop\\shot.png")' },
  { n: 'Open an app', k: 'open launch start app application', mac: 'open -a "<app>"', win: 'Start-Process "<app>"' },
  { n: 'Quit an app', k: 'quit close app application', mac: 'osascript -e \'quit app "<app>"\'', win: 'Stop-Process -Name "<app>"' },
  { n: 'Empty the trash', k: 'empty trash bin recycle', mac: 'rm -rf ~/.Trash/*', win: 'Clear-RecycleBin -Force' },
  { n: 'Keep awake for an hour', k: 'keep awake caffeinate no sleep prevent', mac: 'caffeinate -t 3600 &' },

  // network
  { n: 'Is the internet working', k: 'internet working online ping connected check network', u: 'ping -c 4 1.1.1.1', win: 'Test-Connection 1.1.1.1 -Count 4' },
  { n: 'My public IP address', k: 'public ip address external my ip', u: 'curl -s https://ifconfig.me', win: '(Invoke-RestMethod https://ifconfig.me/ip)' },
  { n: 'My local IP address', k: 'local ip address lan network wifi', mac: 'ipconfig getifaddr en0', lin: 'hostname -I', win: 'Get-NetIPAddress -AddressFamily IPv4 | Select-Object IPAddress,InterfaceAlias' },
  { n: 'Which Wi-Fi am I on', k: 'wifi network name ssid connected', mac: 'networksetup -getairportnetwork en0', lin: 'iwgetid -r', win: 'netsh wlan show interfaces' },
  { n: 'What is using a port', k: 'port in use using listening who 3000 8080 address already', u: 'lsof -i :<port>', win: 'Get-NetTCPConnection -LocalPort <port> | Select-Object OwningProcess,State' },
  { n: 'Free up a port', k: 'kill port free stop server 3000 8080 address already in use', u: 'lsof -ti :<port> | xargs kill', win: 'Stop-Process -Id (Get-NetTCPConnection -LocalPort <port>).OwningProcess' },
  { n: 'All listening ports', k: 'listening ports open servers running', u: 'lsof -iTCP -sTCP:LISTEN -P -n', lin: 'ss -tlnp', win: 'Get-NetTCPConnection -State Listen' },
  { n: 'Internet speed (download)', k: 'speed test internet fast slow download', u: 'curl -o /dev/null -s -w "%{speed_download}\\n" https://speed.cloudflare.com/__down?bytes=25000000', mac: 'networkQuality' },
  { n: 'Download a file', k: 'download file url get fetch', u: 'curl -LO <url>', win: 'Invoke-WebRequest <url> -OutFile <file>' },
  { n: 'Check a website is up', k: 'website up down check status url', u: 'curl -sI <url> | head -1', win: '(Invoke-WebRequest <url> -Method Head).StatusCode' },

  // git
  { n: 'Git: what changed', k: 'git status changes changed modified', u: 'git -C <folder> status', win: 'git -C <folder> status' },
  { n: 'Git: get latest code', k: 'git pull update latest code', u: 'git -C <folder> pull', win: 'git -C <folder> pull' },
  { n: 'Git: save and push', k: 'git commit push save upload', u: 'git -C <folder> add -A && git -C <folder> commit -m "<message>" && git -C <folder> push', win: 'git -C <folder> add -A; git -C <folder> commit -m "<message>"; git -C <folder> push' },
  { n: 'Git: recent commits', k: 'git log history commits recent', u: 'git -C <folder> log --oneline -15', win: 'git -C <folder> log --oneline -15' },
  { n: 'Git: which branch', k: 'git branch current which', u: 'git -C <folder> branch --show-current', win: 'git -C <folder> branch --show-current' },
  { n: 'Git: switch branch', k: 'git switch checkout branch change', u: 'git -C <folder> switch <branch>', win: 'git -C <folder> switch <branch>' },
  { n: 'Git: undo local changes to a file', k: 'git undo discard revert restore file changes', u: 'git -C <folder> restore <file>', win: 'git -C <folder> restore <file>' },
  { n: 'Git: clone a repo', k: 'git clone download repo repository', u: 'git clone <url>', win: 'git clone <url>' },

  // dev
  { n: 'Run npm start', k: 'npm start node run app server', u: 'cd <folder> && npm start', win: 'cd <folder>; npm start' },
  { n: 'Install npm packages', k: 'npm install packages dependencies node modules', u: 'cd <folder> && npm install', win: 'cd <folder>; npm install' },
  { n: 'Run a Python script', k: 'python run script py', u: 'python3 <file>.py', win: 'python <file>.py' },
  { n: 'Install a Python package', k: 'pip install python package library', u: 'pip3 install <package>', win: 'pip install <package>' },
  { n: 'Run in background (keeps going)', k: 'background nohup keep running long detach', u: 'nohup <command> > ~/out.log 2>&1 &', win: 'Start-Process -WindowStyle Hidden powershell "-c <command>"' },
  { n: 'Running Docker containers', k: 'docker containers running ps list', u: 'docker ps', win: 'docker ps' },
  { n: 'Docker logs', k: 'docker logs container output', u: 'docker logs --tail 50 <container>', win: 'docker logs --tail 50 <container>' },
  { n: 'Restart a Docker container', k: 'docker restart container', u: 'docker restart <container>', win: 'docker restart <container>' },
  { n: 'Versions of node, python, git', k: 'version node python git installed which', u: 'node -v; python3 -V; git --version', win: 'node -v; python -V; git --version' },
  { n: 'Where a program is installed', k: 'which where path installed location program', u: 'which <program>', win: 'Get-Command <program>' },
  { n: 'Install with Homebrew', k: 'brew homebrew install app tool', mac: 'brew install <name>' },
  { n: 'Install with winget', k: 'winget install app tool', win: 'winget install <name>' },
  { n: 'Scheduled jobs (cron)', k: 'cron scheduled jobs tasks crontab', u: 'crontab -l', win: 'Get-ScheduledTask | Where-Object State -ne Disabled | Select-Object -First 20 TaskName,State' },
  { n: 'Environment variable', k: 'environment variable env path', u: 'echo $<NAME>', win: '$env:<NAME>' },
];

const STOP = new Set('a an the to of in on for my me i is it and or how do can what with from all this that show get please want'.split(' '));
const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9.:\-_ ]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));

export function cmdFor(entry, os) {
  if (os === 'win32') return entry.win || null;
  if (os === 'linux') return entry.lin || entry.u || null;
  return entry.mac || entry.u || null; // darwin (default)
}

// history: [{cmd, name?, from:'saved'|'recent'}]
export function search(query, os, history = []) {
  const q = query.trim(); if (!q) return [];
  const qw = words(q), ql = q.toLowerCase();
  const out = [];
  for (const h of history) {
    const c = h.cmd.toLowerCase();
    let s = 0;
    if (c.startsWith(ql)) s = 8; else if (c.includes(ql)) s = 5;
    else { const hit = qw.filter((w) => c.includes(w) || (h.name || '').toLowerCase().includes(w)).length; if (hit && hit === qw.length) s = 3; }
    if (s) out.push({ name: h.name || (h.from === 'saved' ? 'Saved' : 'You ran this before'), cmd: h.cmd, from: h.from, score: s + 1 });
  }
  for (const e of LIB) {
    const cmd = cmdFor(e, os); if (!cmd) continue;
    const c = cmd.toLowerCase(), hay = (e.n + ' ' + e.k).toLowerCase();
    let s = 0;
    if (c.startsWith(ql) && ql.length > 1) s += 7;
    for (const w of qw) {
      if (hay.split(/\s+/).includes(w)) s += 2;
      else if (w.length > 2 && hay.includes(w)) s += 1;
      else if (w.length > 1 && c.includes(w)) s += 1;
    }
    if (s > 1 || (qw.length === 1 && s)) out.push({ name: e.n, cmd, from: 'library', score: s });
  }
  for (const r of out) if (r.from === 'library') r.cmd = autofill(r.cmd, q, os);
  const seen = new Set();
  return out.sort((a, b) => b.score - a.score).filter((r) => !seen.has(r.cmd) && seen.add(r.cmd)).slice(0, 8);
}

// Fill obvious blanks from what you typed: "free up port 3000" → <port> = 3000, "big files in downloads" → ~/Downloads.
const PLACES = { downloads: 'Downloads', desktop: 'Desktop', documents: 'Documents', docs: 'Documents', pictures: 'Pictures', music: 'Music', movies: 'Movies', videos: 'Videos', home: '' };
function autofill(cmd, q, os) {
  const ql = q.toLowerCase();
  const num = ql.match(/\b(\d{2,5})\b/);
  if (num) cmd = cmd.replace(/<port>/g, num[1]);
  for (const [w, dir] of Object.entries(PLACES)) {
    if (new RegExp('\\b' + w + '\\b').test(ql)) { cmd = cmd.replace(/<folder>/g, dir ? (os === 'win32' ? '~\\' : '~/') + dir : '~'); break; }
  }
  return cmd;
}

// Local safety check. Runs on every suggestion, AI or not, whatever the AI says.
const DANGER = [
  [/\brm\s+(-\w*[rf]\w*\s+)+/, 'danger', 'deletes files for good'], [/\b(mkfs|diskutil\s+erase|format-volume|clear-disk)/i, 'danger', 'erases a disk'],
  [/\bdd\s+if=/, 'danger', 'writes raw data to a disk'], [/\b(shutdown|reboot|poweroff|restart-computer|stop-computer)\b/i, 'danger', 'turns the computer off, so you lose the connection'],
  [/remove-item[^|;]*-recurse/i, 'danger', 'deletes a whole folder'], [/clear-recyclebin|\.trash/i, 'danger', 'empties the trash'],
  [/git\s+(push\s+.*(-f|--force)|reset\s+--hard|clean\s+-\w*f)/, 'danger', 'throws away git work'],
  [/(curl|wget|iwr|invoke-webrequest)[^|]*\|\s*((ba|z)?sh|iex)\b/i, 'danger', 'runs code downloaded from the internet'], [/:\(\)\s*\{/, 'danger', 'crashes the computer'],
  [/\bsudo\b/, 'careful', 'needs your password (works in the live terminal only)'], [/\brm\b|remove-item/i, 'careful', 'deletes something'],
  [/\bkill(all)?\b|pkill|stop-process/i, 'careful', 'stops programs'], [/chmod\s+-R|chown\s+-R/, 'careful', 'changes permissions on many files'],
  [/>\s*[~/\w$]/, 'careful', 'writes over a file'],
];
export function riskOf(cmd) {
  const c = String(cmd).replace(/\d?>\s*(\/dev\/null|\$null)|2>&1/g, '');
  for (const [re, level, why] of DANGER) if (re.test(c)) return { level, why };
  return null;
}
export const needsFill = (cmd) => /<[^<>\s][^<>]*>/.test(cmd);

// ---------- AI ----------
export const PROVIDERS = {
  openrouter: { label: 'OpenRouter: one key, every model (GPT, Claude, Gemini, Llama…)', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'openai/gpt-4.1-mini', keyUrl: 'openrouter.ai/keys' },
  openai: { label: 'OpenAI (ChatGPT models)', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4.1-mini', keyUrl: 'platform.openai.com/api-keys' },
  anthropic: { label: 'Anthropic (Claude)', url: 'https://api.anthropic.com/v1/messages', model: 'claude-haiku-5-5', keyUrl: 'console.anthropic.com' },
  gemini: { label: 'Google Gemini (free key)', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-2.5-flash', keyUrl: 'aistudio.google.com/apikey' },
  groq: { label: 'Groq (free key)', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile', keyUrl: 'console.groq.com/keys' },
  mistral: { label: 'Mistral', url: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-small-latest', keyUrl: 'console.mistral.ai' },
  deepseek: { label: 'DeepSeek', url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat', keyUrl: 'platform.deepseek.com' },
  xai: { label: 'xAI (Grok)', url: 'https://api.x.ai/v1/chat/completions', model: 'grok-3-mini', keyUrl: 'console.x.ai' },
  custom: { label: 'Custom (any OpenAI-compatible API)', url: '', model: '', keyUrl: '' },
};

const OS_NAME = { darwin: 'macOS (zsh)', linux: 'Linux (bash)', win32: 'Windows (PowerShell 5.1)' };
function systemPrompt(os) {
  return `You turn plain-English requests into terminal commands for ${OS_NAME[os] || OS_NAME.darwin}.
The command runs non-interactively in the user's home folder. It cannot ask questions or open editors (no vim, nano, less, top without -l).
The user may also type a half-remembered command; then complete or fix it.
The user may also paste a command that failed with its output; then explain the cause in the note field and give the fixed command.
Reply with JSON only, no markdown:
{"options":[{"command":"...","explain":"what it does, one short plain sentence","risk":"safe|careful|danger"}],"note":"optional, only if something is unclear"}
Give 1 option, or up to 3 if there are clearly different ways. Prefer safe, read-only commands. Use placeholders like <folder> only when you truly cannot guess.
risk: safe = only reads; careful = changes something you can undo; danger = deletes, overwrites, needs sudo, or turns things off.`;
}

function parseReply(text) {
  const m = String(text).match(/\{[\s\S]*\}/); if (!m) throw new Error('The AI gave an answer I could not read. Try again.');
  const j = JSON.parse(m[0]);
  const options = (Array.isArray(j.options) ? j.options : j.command ? [j] : [])
    .filter((o) => o && typeof o.command === 'string' && o.command.trim())
    .slice(0, 3).map((o) => ({ cmd: o.command.trim(), explain: String(o.explain || ''), risk: ['safe', 'careful', 'danger'].includes(o.risk) ? o.risk : 'careful' }));
  if (!options.length) throw new Error(j.note || 'No command came back. Try saying it another way.');
  return { options, note: typeof j.note === 'string' ? j.note : '' };
}

export async function askAi(cfg, request, os, signal) {
  const p = PROVIDERS[cfg.provider] || PROVIDERS.groq;
  const url = (cfg.provider === 'custom' ? cfg.url : p.url) || cfg.url, model = cfg.model || p.model, sys = systemPrompt(os);
  if (!/^https:\/\//.test(url || '')) throw new Error('Set the API address (https://…) in Settings → AI helper.');
  if (!model) throw new Error('Set a model name in Settings → AI helper.');
  let res;
  if (cfg.provider === 'anthropic') {
    res = await fetch(url, { method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model, max_tokens: 600, system: sys, messages: [{ role: 'user', content: request }] }) });
  } else {
    res = await fetch(url, { method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify({ model, temperature: 0.2, max_tokens: 600, messages: [{ role: 'system', content: sys }, { role: 'user', content: request }] }) });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.error?.message || body.error || body.message || res.statusText;
    if (res.status === 401 || res.status === 403) throw new Error('The AI key was refused. Check it in Settings.');
    if (res.status === 429) throw new Error('The AI says: too many requests. Wait a minute.');
    throw new Error(`AI error ${res.status}: ${String(msg).slice(0, 140)}`);
  }
  const text = cfg.provider === 'anthropic' ? (body.content || []).map((c) => c.text || '').join('') : body.choices?.[0]?.message?.content;
  return parseReply(text);
}

export const _test = { parseReply, LIB };
