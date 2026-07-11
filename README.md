# evo-voice-cli (`evov`)

Command-line interface for [Evo Voice](https://evovoice.io) — for humans and AI agents.

A full operator CLI for the Evo Voice REST API, designed for humans and coding agents. It supports untruncated session investigation, bulk resource management, compact flow understanding, validated graph edits, reusable flow blueprints, and portable cross-account migrations without pushing massive API payloads into model context.

Inspired by [`qbo-cli`](https://qbo-cli.com/) and modelled on its sibling [`better-vapi-cli`](https://github.com/EvoTechMike/Better-Vapi-CLI).

## API coverage

| Resource       | Status | First-class coverage |
|----------------|--------|----------------------|
| auth / env     | ✅ | Login, status, identity, logout, environment switching |
| account        | ✅ | Accessible list/use/get plus admin search/create/patch/check/token regeneration/delete |
| session        | ✅ | Search/log/transcript, active/mine, create/patch/end/bulk-delete, call/chat/conference actions |
| endpoint       | ✅ | Full filtering, get/create/patch/delete, numbers, SIP, schedules, caller ID, duplicates, Cogito |
| customer       | ✅ | CRUD, hierarchy filters, inherited/test schedules, staging mode |
| flow           | ✅ | CRUD/copy, compact logic/validation/diff, node metadata, backend and cross-account portable packages |
| file           | ✅ | Metadata search/get, multipart upload/replace, patch/delete |
| ai-session     | ✅ | CRUD, action apply/clear/delete, AI usage |
| report         | ✅ | All report types, queue status/list/get, workbook download/delete |
| integration    | ✅ | CRUD, CRM search/mapping, logs and sync |
| sys            | ✅ | Log entries, global/account settings and dialing permissions |
| confirm        | ✅ | Production two-phase write gate, including multipart uploads |
| api            | ✅ | Complete low-level JSON, multipart, and binary-download escape hatch |

The first-class commands cover the operator-facing management API. Internal callback/node routes and newly deployed routes remain immediately accessible through `evov api`, with the same authentication, account banner, dry-run behavior, and production write gate.

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

An Evo Voice login can give access to many accounts. Acting on the wrong one is expensive. The CLI handles this three ways:

**1. Idle tenant-context gate.** Account-scoped commands stop after 15 minutes without tenant activity by default. The CLI exits 13 and requires the active tenant's exact name or ID to be reconfirmed before any more API access:

```bash
evov whoami                         # shows tenantGuard status without extending activity
evov account confirm "Acme Corp"   # only after the user confirms this tenant
evov account guard 10              # configure 1..1440 minutes
evov account guard off             # disable explicitly
```

`account list`, `account use`, `account confirm`, authentication/environment commands, schema/help, and local flow-file/blueprint inspection remain available during lockout. Switching accounts clears confirmation. Cross-tenant one-call `--account-id` overrides are refused while the guard is enabled; switch and reconfirm instead.

**2. Mandatory env/account banner on stderr** before every call:
```
[PROD] evovoice.io · acct=Acme Corp (5f8e6a…) · user=mike@evo.tech
```
Production banners are tinted red, staging yellow. Suppressible with `--quiet` or `EVO_VOICE_NO_BANNER=1` for piping.

**3. Two-phase confirmation for production writes.** Any `create`/`update`/`delete` on the prod env does NOT execute immediately. It records the planned request, returns a token, and exits 11 with a human-readable summary that names the target account. To execute, run `evov confirm <token>`. Tokens are single-use, 5-min TTL, bound to the env they were created in. Confirmation also checks the pending action's tenant idle guard before executing.

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

Within the active window, reads and staging writes run normally (`session delete` requires `--force`). Neither `whoami` nor local/offline flow inspection silently extends tenant activity.

## Use with Claude Code

The skill at [`skills/evovoice/SKILL.md`](skills/evovoice/SKILL.md) teaches Claude the complete CLI surface, including session investigation, resource administration, compact flow analysis, safe flow modification, portable cross-account flow packages, and the two-phase production gate.

```bash
# 1. Install the CLI globally
npm i -g evo-voice-cli

# 2. Install the skill
npx skills add -g Evo-Technologies/evo-voice-cli

# 3. Log in
evov env use staging                # work safely first
evov auth login
```

After that, you can ask Claude things like *"show me the full log for session X"*, *"explain this flow without loading its raw JSON"*, *"move this flow to another account and preflight its resource mappings"*, or *"set managerAccess to ReadOnly on every soft-phone user in customer Y"*.

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

# The rest of the management API
evov customer list --name "Acme" --all
evov flow export "$FLOW_ID" --out flow-package.json
evov flow import -f flow-package.json
evov flow logic "$FLOW_ID" --out flow-logic.json       # compact graph; secrets redacted
evov flow validate "$FLOW_ID"
evov flow diff "$OLD_FLOW_ID" "$NEW_FLOW_ID"
evov flow impact "$FLOW_ID"                              # callers, endpoints, dependencies
evov flow node set "$FLOW_ID" start Timeout --value 45 --preview
evov flow connect "$FLOW_ID" start OnFailure voicemail --preview
evov flow edit "$FLOW_ID" -f operations.json --preview   # batch targeted edits
evov flow export-portable "$FLOW_ID" --out portable-flow.json  # invoked subflows included recursively
evov flow import-portable -f portable-flow.json --preflight
# Add explicit source-id → destination-id entries if preflight finds missing/ambiguous resources:
evov flow import-portable -f portable-flow.json --map resource-map.json
evov flow reconcile-portable -f portable-flow.json --map resource-map.json --preview
evov flow blueprint save standard-triage "$FLOW_ID" --revision 1
evov flow blueprint apply standard-triage --revision 1 --set timeout=30 --preflight
evov file upload greeting.wav --customer-id "$CID" --content-type audio/wav
evov report run call-history --start-date 2026-05-01 --end-date 2026-05-10
evov report download "$REPORT_ID" --out report.xlsx
evov integration sync "$INTEGRATION_ID"
evov sys log-entries --start-date 2026-05-01 --description "updated"

# Low-level API escape hatch — internal callbacks or newly deployed endpoints.
# Same auth cookies, same prod two-phase gate; omit the leading slash
# under Git Bash (or set MSYS_NO_PATHCONV=1) to dodge MSYS path mangling.
evov api GET "flows?accountIds=$AID"
evov api POST customers -d '{"accountId":"'$AID'","name":"Harness"}'
evov api POST flows -f newflow.json          # large bodies from a file
evov api DELETE "sessions/$SID" --force      # DELETE always needs --force
evov api POST files --upload greeting.wav --content-type audio/wav --form "accountId=$AID"
evov api GET "reports/$RID.xlsx" --download --out report.xlsx

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

`0` ok · `1` err · `2` usage · `3` empty · `4` auth · `5` not-found · `6` forbidden · `7` rate-limit · `8` retryable upstream · `9` not-impl · `10` config · **`11` production confirmation required** · **`12` concurrent-change/verification conflict** · **`13` tenant reconfirmation required**

## Environment variables

| Variable                | Purpose                                                              |
|-------------------------|----------------------------------------------------------------------|
| `EVO_VOICE_CONFIG_DIR`  | Override config dir (default `~/.config/evo-voice`)                  |
| `EVO_VOICE_CACHE_DIR`   | Override cache dir for pending actions (default `~/.cache/evo-voice`)|
| `EVO_VOICE_USER`        | Default `--user` for `auth login`                                    |
| `EVO_VOICE_PASSWORD`    | Default `--password` for `auth login`                                |
| `EVO_VOICE_NO_BANNER`   | Set to `1` to suppress the env/account banner                        |
| `EVO_VOICE_TENANT_IDLE_MINUTES` | Override guard timeout with 1..1440, 0, or `off`            |
| `EVO_VOICE_SMOKE_ACCOUNT` | Staging account for the opt-in flow smoke test                      |
| `EVO_VOICE_SMOKE_SOURCE_FLOW_ID` | Existing flow copied into a disposable smoke flow           |

## Development

```bash
npm install
npm run build          # tsup → dist/cli.js
npm run typecheck
npm test               # vitest (mocked fetch — never hits the real API)
node dist/cli.js --help

# Opt-in real staging test. Creates and cleans up only EVOV-CLI-SMOKE-* flows.
EVO_VOICE_USER=... EVO_VOICE_PASSWORD=... \
EVO_VOICE_SMOKE_SOURCE_FLOW_ID=... npm run test:staging-flow
```

## License

MIT
