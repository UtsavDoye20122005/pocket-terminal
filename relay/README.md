# Relay mode (advanced, optional)

Most people should use the default **direct mode** (no server needed). Relay mode is for people
who want an always-on server in the middle, for example to get web-push notifications without
the ntfy app, or because their networks block direct links entirely.

- `relay/server.js`: the relay (login page, terminal, queue, snippets, web push).
- Host it anywhere that runs Node (Render, Fly, a VPS). `deploy/oracle-cloud-init.template.sh`
  sets up a free Oracle Cloud VM with HTTPS.
- On the Mac: `cd agent && node setup.js secrets && node setup.js relay`, then remove
  `~/.pocket-terminal/direct.json` (the agent prefers direct mode when it exists) and restart the agent.
