# Changelog

## 6.2 (2026-10-28)
- Light theme by default, with Settings → Appearance (Light / Dark / Auto) and a matching terminal.
- Demo mode: tap **See a demo first** (or open `#demo`) to try the whole app with a pretend
  computer. It never connects anywhere or touches your pairing.
- Motion: the lamp line ignites when the link goes live, pages slide, the menu springs open,
  lists settle in. All of it switches off with Reduce Motion.

## 6.0–6.1
- Redesigned phone app: one clean terminal screen, a single key bar that sits on the keyboard,
  and a simple menu.
- Security: pairing links can't silently replace an existing pairing; PIN lock uses 600,000
  PBKDF2 rounds (old locks upgrade themselves); installs use `npm ci` with exact versions.
- CI runs unit and end-to-end tests on every push; CodeQL and Dependabot watch the repo.

## 5.4 (2026-10-25)
- Paste works after switching apps; typing during a reconnect is kept and sent.
- Coming back to the app continues the same terminal; reopening a closed app starts a fresh one.
- Swiping scrolls only the terminal; key bar taps no longer lose keyboard focus; ^X and ^O keys.

## 5.3 (2026-10-25)
- Settings shows the app version and has a Reload button.
- A removed phone is told so and forgets its key. `pair.js --list` shows numbers and times.

## 5.2 (2026-10-25)
- The computer always keeps a wake-up alarm set ahead when sleep is allowed, so it checks in even
  when macOS sleeps on its own. The phone keeps retrying and reconnects by itself.
- Low battery: still checks in (every 10 minutes) instead of skipping the mailbox.

## 5.1 (2026-10-25)
- Pair from inside the iPhone home-screen app: Scan QR code (camera) or Paste pairing link.

## 5.0 (2026-10-25)
- One-time QR pairing approved on the computer with a 6-digit code; a separate key per phone;
  list and remove phones.
- Ask: any AI provider (OpenAI, Claude, Gemini, Groq, OpenRouter, Mistral, DeepSeek, xAI or any
  OpenAI-compatible API), Test button, and Fix with AI for failed commands.

## 4.x (2026-10-24)
- Direct peer-to-peer mode, the power brain for lid-closed use on battery, Windows support (beta),
  built-in command finder, and the night-themed phone app.
