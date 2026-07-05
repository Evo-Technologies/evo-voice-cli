# Evo Voice CLI (`evov`) — Support Team Setup

One-time setup takes about five minutes. You'll install Node, install the CLI, and sign in with your normal Evo Voice dashboard email and password.

## 1. Install Node.js (once)

Download and run the **LTS** installer from https://nodejs.org — accept all defaults. Then open a **new** terminal (PowerShell on Windows) and confirm:

```
node --version
```

Any version 18 or higher is fine.

## 2. Install the CLI

```
npm i -g evo-voice-cli
evov --version
```

To update later: `npm update -g evo-voice-cli`

## 3. Sign in

No API keys — use your Evo Voice dashboard login:

```
evov env use staging
evov auth login
evov whoami
```

`whoami` shows which environment and account you're pointed at. **Always check the banner** — every command prints the current environment and account on the first line (red = production, yellow = staging).

Switch to production only when you need it:

```
evov env use prod
```

## 4. Production safety — read this

Reads (`list`, `get`, `log`) always run immediately, on any environment.

Any **write** on production (patch, delete) does **not** run immediately. The CLI prints a summary of what it's about to do, plus a token, and exits. Nothing has happened yet. Read the summary — especially the **account name** — and if it's what you intended, run:

```
evov confirm <token>
```

Tokens expire after 5 minutes and work once. If you're unsure, just don't confirm — nothing happens.

## 5. Using it with Claude Code (recommended)

If you use Claude Code, install the skill so Claude knows how to drive the CLI:

```
npx skills add -g Evo-Technologies/evo-voice-cli
```

Then you can ask things like *"show me the full log for session X and tell me why the call failed"*. When Claude proposes a production write, it will show you the confirmation summary and wait for your explicit go-ahead — same safety gate as above.

## Common tasks

```
# Sessions in a date range
evov session list --start-date 2026-07-01 --end-date 2026-07-05

# Full log for one session
evov session log <session-id>

# Find sessions whose log mentions a phrase
evov session list --log "timeout" --start-date 2026-07-01
```

Full command reference: `evov --help`, or `evov <command> --help`.

## Help

- Package: https://www.npmjs.com/package/evo-voice-cli
- Source and issues: https://github.com/Evo-Technologies/evo-voice-cli
