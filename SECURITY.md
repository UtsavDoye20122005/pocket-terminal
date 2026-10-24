# Security

Pocket Terminal gives your phone **full shell access to your Mac**. This page explains how
that access is protected, and where the limits are.

## What protects you

| Layer | How |
|---|---|
| **Pairing key** | 32 random bytes made on your Mac. It travels to the phone only inside the QR link's `#fragment`, which browsers never send to any server. |
| **Private mailbox** | The board topic is derived from the key (HKDF-SHA256). Without the key, nobody can find it. |
| **Every note encrypted + authenticated** | AES-256-GCM with a key derived from the pairing key. A forged or tampered note is rejected. The mailbox name is bound into every note, so notes can't be moved between mailboxes. |
| **Direct link** | WebRTC data channel, encrypted with DTLS. The DTLS fingerprints travel inside the authenticated notes, so nobody (including the board) can sit in the middle. |
| **Replay protection** | Every note has a unique id and a timestamp. The Mac remembers ids it has seen. Offers expire after 90 s, wake requests after 3 min, commands after 60 min (configurable). |
| **Phone at rest** | The pairing key is stored encrypted with your PIN (PBKDF2-SHA256, 310k rounds, AES-GCM). After 10 wrong PINs the phone forgets the key. An "unlocked for 12 h" session keeps only a non-extractable WebCrypto key. |
| **Phone app** | Static files with a strict Content-Security-Policy: no inline scripts, no third-party scripts, and no analytics. |
| **Mac admin rights** | The agent can run exactly 4 `pmset` commands without a password (sleep control). `sudo` for anything else still asks for your password. |
| **Windows** | No admin rights at all. The agent changes only your own power plan's lid-close action (restored when it stops or is uninstalled) and one wake-up task in Task Scheduler. |
| **Logs** | Command text and output are never written to the agent log. The log file is only readable by you. |
| **Notifications** | ntfy pings are content-free ("Command finished ✅"). |
| **AI helper (optional)** | Off by default. Your own key is stored encrypted with the pairing key. Only the text you type in **Ask** is sent, directly from the phone to the provider you chose. Suggestions never run by themselves, and every one passes a local danger check that doesn't trust the AI's own label. |
| **Revocation** | `node pair.js --new` makes a new key. Every phone paired before is locked out immediately. |

## What the message board can see
- That *some* encrypted notes were posted to a random-looking topic, when, from which IP
  address, and how big they were.
- **Not** your commands, output, Mac name, IP addresses inside the link setup, or anything readable.

The STUN servers (Google/Cloudflare) see your public IP addresses while the direct link is being
set up, the same as in any video call. They never see your data.

## What it does NOT protect against
- **Someone who has your unlocked phone,** or your pairing QR code. Treat the QR like a password:
  don't screenshot it. If it leaks, run `node pair.js --new`.
- **A short PIN against an attacker who copies your phone's storage.** 6 digits can be guessed
  offline. Use a longer passphrase if that's in your threat model.
- **Whoever controls the phone app's code.** The app is loaded from GitHub Pages. If you use
  someone else's copy, you trust them not to change it. **Fork the repo and use your own Pages
  copy.** The installer does this automatically for forks.
- **A compromised Mac or phone** (malware) is out of scope.
- **Commands you choose to run.** It's your shell. `rm -rf ~` works.

## Reporting a problem
Please open a GitHub issue *without* exploit details, or message the maintainer privately on GitHub.
