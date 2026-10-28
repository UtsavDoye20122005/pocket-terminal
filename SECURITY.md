# Security

Pocket Terminal gives a phone **full shell access to your computer**. This page says how that
access is protected, what an attacker could and couldn't do, and where the limits are.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private report instead:
**Security → Report a vulnerability** on this repository. You'll get a reply within 7 days.
Fixes are released as soon as possible and credited in the [changelog](CHANGELOG.md) if you like.

## Threat model at a glance

| If an attacker… | …they can | …they can't |
|---|---|---|
| reads this public repo | learn how everything works | do anything to you: security never depends on the code being secret |
| watches the message board (ntfy.sh) | see that encrypted notes exist, their size and timing | read, change, forge or replay a note |
| sits on your Wi-Fi or ISP | see encrypted traffic | read it, or get between your phone and computer |
| photographs your pairing QR | try to pair *while it's still valid* | pair without you typing `y` next to a matching code; read the phone's key |
| sends you a pairing link | ask you to pair with *their* computer | replace your pairing silently: the app warns that it's already paired |
| steals your locked phone | try PINs | get past 10 wrong PINs (the key is wiped) or stay paired after `pair.js --remove` |
| takes over your GitHub account | change the phone app hosted from your repo | change the program on your computer (it never updates itself) |
| changes a dependency on npm | publish a bad version | reach you: the installer uses `npm ci` with exact versions and a lockfile |

## What protects you

| Layer | How |
|---|---|
| **One-time pairing** | The QR code holds a one-time invite (valid 10 min). The phone sends its own P-256 public key; both screens show a 6-digit code made from it and you type `y` on the computer. A second phone trying the same invite cancels the pairing. An old QR does nothing. |
| **A key per phone** | After approval the computer makes a new 32-byte key just for that phone and sends it wrapped with ECDH (computer's one-off key × phone's key), so the QR alone can't unwrap it. `node pair.js --remove <number>` locks one phone out within seconds, and that phone is told so. |
| **Re-pair guard** | A phone that's already paired asks before a pairing link can replace its pairing. |
| **Private mailbox** | Each phone's board topic is derived from its key (HKDF-SHA256). Without the key, nobody can find it. |
| **Every note encrypted and authenticated** | AES-256-GCM with a key derived from the phone's key. The mailbox name is bound into every note. A forged, altered or moved note is rejected. |
| **Direct link** | WebRTC data channel, encrypted with DTLS. The DTLS fingerprints travel inside the authenticated notes, so nobody (including the board) can sit in the middle. |
| **Replay protection** | Every note has a unique id and a timestamp. The computer remembers ids it has seen. Offers expire after 90 s, wake requests after 3 min, commands after 60 min. |
| **Phone at rest** | The phone's key is encrypted with your PIN (PBKDF2-SHA256, 600,000 rounds, AES-GCM; older vaults are upgraded at the next unlock). 10 wrong PINs wipe it. "Stay unlocked for 12 h" keeps only a non-extractable WebCrypto key. |
| **Phone app** | Static files, strict Content-Security-Policy (no inline or third-party scripts, no `eval`), no analytics, no trackers. Everything shown on screen is escaped. |
| **Computer: admin rights** | macOS: the program can run exactly 4 `pmset` sleep commands without a password; `sudo` for anything else still asks. Windows: no admin rights at all. |
| **Computer: no self-updates** | The program on your computer only changes when *you* run `git pull`. Nothing is downloaded or updated in the background. |
| **Dependencies** | 4 runtime dependencies, exact versions, installed with `npm ci` from the lockfile. Dependabot and CodeQL watch the repo. |
| **Logs and notifications** | Command text and output are never written to the log (readable only by you). ntfy pings are content-free ("Command finished ✅"). |
| **AI helper (optional)** | Off by default. Your key is stored encrypted with the phone's key. Only what you type in **Ask** (and, for *Fix with AI*, that command and the end of its output) goes to the provider you chose. Suggestions never run by themselves and pass a local danger check that doesn't trust the AI's label. |

## If someone takes over your GitHub account

The phone app is a website served from your repository (GitHub Pages). Like every web app,
**whoever controls where it's hosted controls its code.** A hijacked account could publish a
changed app that, the next time you unlock it, sends your phone's key elsewhere. The program on
your computer stays unchanged, but the stolen key would let the attacker use it.

Protect the account, because it is the root of trust:

1. **Two-factor authentication** with a passkey or authenticator app (Settings → Password and authentication).
2. **Protect `main`**: Settings → Rules → Rulesets → new branch ruleset for `main`, with
   *Block force pushes* and *Restrict deletions* on.
3. **Pages only from `main`** (Settings → Pages), so no other branch can change the app.
4. **Review sign-in alerts** and remove apps you don't use under Settings → Applications.
5. **If you suspect anything:** run `node pair.js --remove all` on your computer. Every phone is
   locked out at once; pair again when things are safe.

If you don't want to trust anyone else's hosting, fork the repo: the installer then points your
phone at your own copy.

## What the message board and STUN servers see

- **Board:** that encrypted notes were posted to a random-looking topic, when, from which IP
  address, and how big they were. **Not** commands, output, names or addresses inside them.
- **STUN servers (Google, Cloudflare):** your public IP addresses while the direct link is set up,
  as in any video call. Never your data.

## Not covered

- **Someone using your unlocked phone.** Lock it (☰ → Settings → Lock now) or remove it from the computer.
- **Typing `y` without comparing the code.** The 6-digit check only helps if you look.
- **Short PINs against someone who copies your phone's storage.** 6 digits can be guessed offline
  with enough computing power. Use 8 or more if that matters to you.
- **Malware already on your computer or phone.**
- **Commands you choose to run.** It's your shell: `rm -rf ~` works.
