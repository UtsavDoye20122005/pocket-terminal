# Contributing

Thanks for helping. Pocket Terminal is small on purpose: a phone app made of static files
(`docs/`) and a program for the computer (`agent/`), with no server of its own.

## Ground rules

- **Security first.** Anything that touches pairing, keys or what runs on the computer needs a
  test and a line in [SECURITY.md](SECURITY.md) if it changes the threat model.
- **No new runtime dependencies** unless there is no reasonable way around it. The agent has four.
- **No build step for the phone app.** Plain HTML, CSS and ES modules. Third-party code lives in
  `docs/vendor/` with its license header.
- **Plain words** in the UI and docs. If a 15-year-old can't follow a sentence, rewrite it.

## Running it locally

```bash
cd agent && npm ci && npm test              # unit tests
pip install playwright && python -m playwright install chromium
python3 test/e2e_pairing.py                 # one of the end-to-end tests (see README → Tests)
```

The end-to-end tests start a fake message board, the real phone app in a headless browser, and
the real agent with a simulated sleeping computer. Nothing touches the internet or your machine's
power settings.

## Pull requests

1. One topic per PR, with a short "what and why".
2. Tests pass (`npm test` plus the end-to-end test for the part you changed).
3. Add a line to [CHANGELOG.md](CHANGELOG.md) under *Unreleased*.
