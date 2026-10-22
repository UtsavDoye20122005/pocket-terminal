# Pocket Terminal

Your Mac's terminal on your phone, from any Wi-Fi or mobile data, even with the lid closed,
using as little battery as possible. All the code is yours.

```
 📱 phone (browser)  ──https──▶  🖥️ your Oracle server (relay)  ◀──https──  💻 Mac (agent + power brain)
```

## What it does

| | |
|---|---|
| **Live terminal** | Real zsh on your Mac, in your phone's browser. Extra keys: Esc, Tab, Ctrl, Alt, arrows, ^C, ^R, Paste. |
| **Works anywhere** | Mac and phone can be on different Wi-Fi or mobile data. Both dial out to your server. |
| **Lid closed, on charger** | Stays reachable. Instant. No battery used. |
| **Lid closed, on battery** | Really sleeps to save battery. Wakes every few minutes (you choose), runs anything you queued, sleeps again. |
| **Stays awake for you** | While your phone has the terminal open, or you typed in the last 5 min, or a job is running. |
| **Never kills your battery** | Below 20% it stops staying awake. Below 10% it stops waking up at all. |
| **★ Snippets** | One-tap saved commands. If the Mac is asleep, they go to the queue. |
| **Queue** | Commands that run at the next check-in, with the output saved for you. |
| **Notifications** | "✅ job done", "Your Mac is awake". |
| **Power controls on the phone** | See battery % and why it's awake. Change check-in time, battery floor, Saver/Instant. |
| **Auto-update** | Change code on GitHub → your server updates itself within 10 minutes. |

## How the battery saving works

```
           on charger ──────────────▶ AWAKE (lid closed is fine)
                │
           on battery
                │
   phone open / typing / job? ──yes─▶ AWAKE
                │ no
                ▼
   set alarm (+15 min) ─▶ SLEEP ─▶ alarm wakes it ─▶ connect, run queue (≈45 s) ─┐
                ▲                                                                  │
                └──────────────────────── nothing to do ◀──────────────────────────┘
```

Each check-in costs about 45 seconds awake. That's roughly 1–3% battery overnight with
15-minute check-ins, close to normal sleep. Your Mac's real numbers may differ: check
`~/.pocket-terminal/agent.log`.

---

## Setup (about 30 minutes, one time)

You need: a GitHub account, an Oracle Cloud account (free, needs a card for verification,
no charge), and your Mac.

### Step 1: Put the code on GitHub (browser)
1. github.com → **New repository** → name `pocket-terminal` → **Public** (the code has no secrets;
   your server downloads it from here) → Create.
2. Click **uploading an existing file**. From `Claude_Work/Projects/pocket-terminal`, drag in the
   `relay`, `agent` and `local` folders plus `README.md` and `.gitignore`. Don't upload `node_modules`.
   Click **Commit changes**.

### Step 2: Run the Mac installer (Terminal, one command)
```
cd ~/Claude_Work/Projects/pocket-terminal/agent && bash install.sh
```
It asks for:
- **A phone password** (12+ characters). This is what you type on your phone.
- **Your Mac login password**, once. This lets the agent switch lid-sleep on/off and set wake alarms.
  It can only run those exact `pmset` commands, nothing else.
- **Your GitHub repo URL.** Press Enter if it's `github.com/UtsavDoye20122005/pocket-terminal`.

It then copies the **Oracle setup script** to your clipboard. When it asks for the server IP,
press **Enter to skip** for now.

### Step 3: Create your Oracle server (browser)
1. Go to **cloud.oracle.com** and sign up for the free tier. For **Home Region**, pick **India South
   (Hyderabad)** or **India West (Mumbai)**. You can't change it later.
2. **☰ Menu → Compute → Instances → Create instance**
   - Name: `pocket-relay`
   - **Image:** click *Change image* → **Canonical Ubuntu 24.04**
   - **Shape:** *Change shape* → **Ampere → VM.Standard.A1.Flex**, 1 OCPU, 6 GB (marked "Always Free").
     If it says "out of capacity", choose **AMD → VM.Standard.E2.1.Micro** instead.
   - **Networking:** keep "Create new virtual cloud network" and **Assign a public IPv4 address: Yes**.
   - **SSH keys:** *Generate a key pair for me* → **Save private key** (only for emergencies).
   - **Show advanced options → Management → Paste cloud-init script** → press **Cmd+V**.
   - Click **Create**.
3. **Open the web ports.** On the instance page, click the **Subnet** link → **Security Lists** →
   **Default Security List** → **Add Ingress Rules**:
   - Source CIDR `0.0.0.0/0`, IP Protocol **TCP**, Destination Port **80** → Add
   - Repeat with Destination Port **443**
4. Copy the **Public IP address** from the instance page (like `140.238.12.34`).
5. Wait about 5 minutes. Then open `https://140-238-12-34.sslip.io` (your IP with dashes) in your
   browser. You should see the **Pocket Terminal** login page. 🎉

### Step 4: Connect your Mac (Terminal, same command)
```
cd ~/Claude_Work/Projects/pocket-terminal/agent && bash install.sh
```
Paste the server IP when asked. It ends with **✅ All set**.

### Step 5: Phone
1. Open `https://<your-ip-with-dashes>.sslip.io` and log in.
2. **iPhone:** Share → **Add to Home Screen**, then open it from the home screen.
   (Needed for notifications and full screen.) **Android:** ⋮ → Install app.
3. ☰ → **Settings → Notifications → Turn on.**

---

## Using it

- **☰ menu:** Snippets, Queue, Power, Settings. **★ key** opens Snippets fast.
- **Red dot** means the Mac is asleep. The banner shows the countdown to the next check-in. Keep the
  page open and it connects by itself, or tap **🔔 Tell me when it's awake**.
- **Power tab:** battery %, why it's awake, and settings:
  - *On battery: Saver / Instant.* Instant = always awake on battery (fast but uses battery).
  - *Check in every:* 5/10/15/30 min. Shorter = faster replies, a bit more battery.
  - *Battery floor:* below this % it won't stay awake, even with your phone open.
  - *Awake on charger:* reachable with the lid closed while charging.

## Good to know

- **Heat:** lid closed + awake + heavy job in a bag = warm Mac. Idle is fine.
- **First real test:** close the lid on battery, wait 20 min, then check `~/.pocket-terminal/agent.log`.
  You want to see `woke up` then `connected to relay`. If it wakes but never connects, your Mac
  isn't turning on Wi-Fi during quiet wake-ups. Then use **Instant** mode on battery, or keep it on charger.
- **Change the phone password:** delete `~/.pocket-terminal/secrets.json`, run the installer again, and
  make a new Oracle server with the new script (or ask Claude to help update the old one).
- **Logs:** Mac: `~/.pocket-terminal/agent.log`. Server: Oracle → instance → Console connection, or
  `journalctl -u pocket-relay`.
- **Update the code:** edit on GitHub. The server pulls it within 10 minutes. On the Mac, re-download
  the files and run the installer.
- **Remove from Mac:** `bash agent/uninstall.sh` (puts lid-sleep back to normal).

## Security

- Whoever knows your phone password controls your Mac. Make it long.
- Only a scrambled (scrypt) version of the password is stored, on the Mac and the server.
- HTTPS everywhere (free Let's Encrypt certificate via Caddy).
- 8 wrong passwords in 15 minutes → login locked for 15 minutes.
- The Mac proves itself with a 64-character secret token.
- The relay only listens inside the server. Caddy is the only door.
- The agent can only run 4 exact `pmset` commands with admin rights, nothing else.
- Next level: end-to-end encryption so even your server can't read your commands.

## Local mode (no server: same Wi-Fi or phone hotspot)

```
cd ~/Claude_Work/Projects/pocket-terminal/local && bash install.sh
```
It runs the relay on the Mac itself. Your phone opens `http://<mac-name>.local:8080`. It uses plain
http, so only use it on your own hotspot.

## Files

```
pocket-terminal/
├── agent/                     runs on your Mac
│   ├── agent.js                  shell + connection to the relay
│   ├── power.js                  the power brain (sleep / wake / battery rules)
│   ├── setup.js                  secrets, Oracle script, server address
│   ├── install.sh / uninstall.sh
│   └── test/                     power tests with a fake Mac:  npm test
├── relay/                     runs on your Oracle server
│   ├── server.js                 login, message passing, queue, snippets, notifications
│   ├── public/                   phone app (index.html, login.html, sw.js)
│   └── deploy/oracle-cloud-init.template.sh   one-shot server setup
└── local/                     everything-on-the-Mac mode
```

## How the pieces talk

All messages are JSON over WebSockets.

| From → To | Message | Meaning |
|---|---|---|
| phone → relay → Mac | `{t:'i', d}` | keystrokes |
| phone → relay → Mac | `{t:'r', cols, rows}` | screen size |
| Mac → relay → phone | `{t:'o', d}` | terminal output |
| relay → Mac | `{t:'want', phones}` | a phone is watching: stay awake |
| relay → Mac | `{t:'job', id, cmd}` | run a queued command |
| relay → Mac | `{t:'settings', power}` | new power settings from your phone |
| Mac → relay | `{t:'power', percent, onCharger, reasons, …}` | battery and why it's awake |
| Mac → relay | `{t:'sleeping', nextWake}` | going to sleep, back at this time |
| Mac → relay | `{t:'jobdone', id, code, out}` | job result |
| relay → phone | `{t:'s', online, nextWake, power}` | status for the header |
# pocket-terminal
