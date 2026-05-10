# evo-voice-cli (`evov`)

Command-line interface for [Evo Voice](https://evovoice.io) — for humans and AI agents.

A thin wrapper over the Evo Voice REST API designed for **session log investigation** and **bulk endpoint updates**. Built so Claude (and other coding agents) can work with full session logs without MCP truncation, and bulk-update endpoints without context blowup.

Inspired by [`qbo-cli`](https://qbo-cli.com/) and modelled on its sibling [`better-vapi-cli`](https://github.com/EvoTechMike/Better-Vapi-CLI).

## Status — phased rollout

| Resource     | Status     | Commands                                 |
|--------------|------------|------------------------------------------|
| auth         | Phase 1 ✅ | `login`, `status`, `whoami`, `logout`    |
| env          | Phase 1 ✅ | `list`, `use`, `current`                 |
| account      | Phase 1 ✅ | `list`, `get`, `use`                     |
| session      | Phase 1 ✅ | `list`, `get`, `log`, `patch`, `delete`  |
| endpoint     | Phase 1 ✅ | `list`, `get`, `patch`                   |
| confirm      | Phase 1 ✅ | `confirm <token>` (prod two-phase gate)  |
| customer     | Phase 2 ⏳ | —                                        |
| flow         | Phase 2 ⏳ | —                                        |
| file         | Phase 3 ⏳ | —                                        |
| ai-session   | Phase 3 ⏳ | —                                        |
| report       | Phase 3 ⏳ | —                                        |
| sys          | Phase 4 ⏳ | —                                        |

`evov schema --json` is the authoritative source for what's actually shipped in the binary you have.

## Install

```bash
npm i -g evo-voice-cli
# or run ad-hoc
npx evo-voice-cli ...
```

Requires Node 18+.

## Configure

Evo Voice uses ServiceStack cookie auth. No API keys — sign in with your dashboard email + password; the CLI stores the session cookies (mode 600, no password at rest).

```bash
evov env use staging                 # or prod
evov auth login                      # prompts for email + password
evov whoami                          # confirm env + account
```

Scripted login:
```bash
echo "$PW" | evov auth login --user mike@evo.tech --password - --account-name "Acme Corp" --no-input
```

Credentials live at `~/.config/evo-voice/credentials.json` (overridable via `EVO_VOICE_CONFIG_DIR`).

## Multi-account, multi-env safety

An Evo Voice login can give access to many accounts. Acting on the wrong one is expensive. The CLI handles this two ways:

**1. Mandatory env/account banner on stderr** before every call:
```
[PROD] evovoice.io · acct=Acme Corp (5f8e6a…) · user=mike@evo.tech
```
Production banners are tinted red, staging yellow. Suppressible with `--quiet` or `EVO_VOICE_NO_BANNER=1` for piping.

**2. Two-phase confirmation for production writes.** Any `create`/`update`/`delete` on the prod env does NOT execute immediately. It records the planned request, returns a token, and exits 11 with a human-readable summary that names the target account. To execute, run `evov confirm <token>`. Tokens are single-use, 5-min TTL, bound to the env they were created in.

```bash
evov session delete --start-date-time 2026-05-01T00:00:00Z --end-date-time 2026-05-10T23:59:59Z
# → exit 11, stdout:
# {
#   "requiresConfirmation": true,
#   "token": "zX9k2pQa",
#   "summary": "Delete sessions for Acme Corp on PRODUCTION between ...",
#   "account": {"id":"5f8e...","name":"Acme Corp"},
#   "env": "prod",
#   "expiresAt": "..."
# }
evov confirm zX9k2pQa
```

The skill instructs the LLM to quote the `summary` verbatim back to the human and wait for explicit confirmation in the next message before running `evov confirm`. This catches the "the LLM was set to the wrong account" failure mode that no flag-based gate can.

Reads (`list`, `get`, `log`) are unaffected — no friction for the 90% case. Staging writes run immediately (`session delete` requires `--force`, matching bvapi convention).

## Use with Claude Code

The skill at [`skills/evovoice/SKILL.md`](skills/evovoice/SKILL.md) teaches Claude how to drive this CLI — investigating session logs, bulk-patching endpoints, and crucially, how to handle the two-phase prod gate.

```bash
# 1. Install the CLI globally
npm i -g evo-voice-cli

# 2. Install the skill
npx skills add -g EvoTechMike/evo-voice-cli

# 3. Log in
evov env use staging                # work safely first
evov auth login
```

After that, you can ask Claude things like *"show me the full log for session X"*, *"why did this call fail?"*, or *"set managerAccess to ReadOnly on every soft-phone user in customer Y"* — Claude uses the skill and `jq` instead of fighting MCP truncation.

## Quick examples

```bash
# Snapshot a window of sessions to disk, then jq locally
evov session list --start-date 2026-05-01 --end-date 2026-05-10 --all --out /tmp/s.json
jq '.items | length' /tmp/s.json
jq '[.items[] | {id, customerName, fromAddress, outcome}]' /tmp/s.json

# Pull a single session's full log — untruncated
evov session log $SID --out /tmp/log.json
jq -r '.[] | "\(.date)\t\(.message)"' /tmp/log.json | less

# Find sessions whose log mentions "timeout"
evov session list --log "timeout" --start-date 2026-05-01 --out /tmp/s.json

# Filter endpoints, then patch the matches
evov endpoint list --type User --customer-id $CID --all --out /tmp/e.json
jq '[.items[] | select(.userMode=="SoftPhone") | .id]' /tmp/e.json > /tmp/ids.json
for ID in $(jq -r '.[]' /tmp/ids.json); do
  echo '{"managerAccess":"ReadOnly"}' | evov endpoint patch "$ID" -f -
done

# Switch env safely
evov env use prod
evov whoami
# (any subsequent write now goes through the two-phase gate)
```

## Output modes

By default, JSON to stdout (pretty in a TTY, compact when piped). Other modes:

- `--json` / `-j` — force JSON
- `--out <path>` — write JSON to file; stdout becomes `{"path":"..."}`
- `--select id,name` — project to top-level fields (also applies inside `.items[]` for ListResponses)
- `--plain` / `-p` — TSV of top-level scalars
- `--dry-run` / `-n` — print the planned `{method,url,body}` and exit 0

## Exit codes

`0` ok · `1` err · `2` usage · `3` empty · `4` auth · `5` not-found · `6` forbidden · `7` rate-limit · `8` retryable upstream · `9` not-impl · `10` config · **`11` confirmation-required (prod write — run `evov confirm <token>`)**

## Environment variables

| Variable                | Purpose                                                              |
|-------------------------|----------------------------------------------------------------------|
| `EVO_VOICE_CONFIG_DIR`  | Override config dir (default `~/.config/evo-voice`)                  |
| `EVO_VOICE_CACHE_DIR`   | Override cache dir for pending actions (default `~/.cache/evo-voice`)|
| `EVO_VOICE_USER`        | Default `--user` for `auth login`                                    |
| `EVO_VOICE_PASSWORD`    | Default `--password` for `auth login`                                |
| `EVO_VOICE_NO_BANNER`   | Set to `1` to suppress the env/account banner                        |

## Development

```bash
npm install
npm run build          # tsup → dist/cli.js
npm run typecheck
npm test               # vitest (mocked fetch — never hits the real API)
node dist/cli.js --help
```

## License

MIT
