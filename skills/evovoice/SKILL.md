---
name: evovoice
description: Manage Evo Voice configuration via the evov CLI — read full session logs (untruncated), investigate calls, bulk-update endpoints, switch between prod and staging, manage accounts. Use whenever the user asks about Evo Voice sessions, calls, endpoints, phone numbers, customers, flows, accounts, users, or session logs.
allowed-tools: Bash(evov *), Bash(jq *), Bash(cat *), Bash(echo *), Bash(date *)
---

# evov — Evo Voice CLI

Thin wrapper over the Evo Voice REST API (ServiceStack on `evovoice.io` / `team.evovoice.io`). Designed so you can dump JSON to disk and process it with `jq`. **List responses are wrapped — use `jq '.items[]'`, not `jq '.[]'`.**

## ⚠ Safety rules — read first

Reads on either env: run freely.
Writes on **STAGING**: run directly. `session delete` requires `--force`.
Writes on **PRODUCTION**: two-phase confirmation (below).

### Two-phase protocol (prod writes)

When you run a write (create / update / delete) on the **prod** env and the CLI exits 11 with stdout `{requiresConfirmation: true, token, summary, account, ...}`:

1. **Quote the `summary` field VERBATIM in your reply** to the user. Do not paraphrase.
2. **Ask explicitly**: "Confirm to proceed on this account/env?"
3. **Wait for an affirmative reply in the user's NEXT message.** Do NOT infer confirmation from anything said earlier in the conversation — even if the user previously said "go ahead with all this." Each phase-1 needs its own fresh "yes".
4. **Only then** run `evov confirm <token>`.
5. If the user says no or asks for changes: do NOT run `evov confirm`. The token expires in 5 minutes. Re-run phase 1 with new params if they want to retry.

The rule exists because the user might be asking about a different account than the CLI is currently set to. The `summary` field names the target account in plain prose — quoting it verbatim gives the user a chance to read "Acme Corp" and reply "wait, no, I meant Beta Corp" before anything destructive happens.

### Multi-account rule

- Run `evov whoami` at the **start of any task** involving a write, and again after any pivot ("now do X on Beta", "switch envs").
- The stderr banner is informational; `evov whoami` JSON is the source of truth.
- If the phase-1 stderr prepends `NOTE: active account was changed N min ago`, **re-verify with the user** before running `evov confirm`.

### Switching

```bash
evov env use prod                    # switch persisted active env
evov env use staging
evov env list                        # both envs, active marked, auth state
evov account use "Acme Corp"         # switch active account inside current env
evov account list                    # see what the current user can access
evov --env staging session list ...  # one-call env override
```

After every switch, run `evov whoami` and read it. Never chain a write after a switch without re-verifying.

### Worked example — the right way

User: *"delete all sessions for last week on prod"*

```bash
evov env use prod
evov whoami
# {"env":"prod","accountName":"Acme Corp",...}
evov session delete --start-date-time 2026-05-04T00:00:00Z --end-date-time 2026-05-10T23:59:59Z
# → exit 11. Stdout:
# {
#   "requiresConfirmation": true,
#   "token": "zX9k2pQa",
#   "summary": "Delete sessions for Acme Corp on PRODUCTION between 2026-05-04T00:00:00Z and 2026-05-10T23:59:59Z",
#   "account": {"id":"5f8e...","name":"Acme Corp"},
#   "env": "prod",
#   "expiresAt": "2026-05-11T17:23:00Z",
#   "action": "DELETE /sessions"
# }
```

Reply to the user, verbatim:

> "Delete sessions for **Acme Corp** on **PRODUCTION** between 2026-05-04T00:00:00Z and 2026-05-10T23:59:59Z. Confirm to proceed on this account/env?"

Wait. Only on explicit "yes":

```bash
evov confirm zX9k2pQa
```

## Install

```bash
npm i -g evo-voice-cli                # installs the `evov` binary
evov env use staging                  # or prod
evov auth login                       # prompts for email + password, picks account if needed
evov whoami                           # confirm env + account
```

Scripted login:
```bash
evov auth login --env staging --user mike@evo.tech --password "$PW" --account-name "Acme Corp" --no-input
```

Credentials are cookie-based, stored in `~/.config/evo-voice/credentials.json` (mode 600). **No password at rest.** When the session expires (401), re-run `evov auth login`.

## Response shape

Evo Voice list endpoints return a **wrapper**. Use `.items[]`, not `.[]`.

| Command  | Returns                                                  | jq pattern         |
|----------|----------------------------------------------------------|--------------------|
| `list`   | `{items, totalCount, totalPages, hasMorePages}`          | `jq '.items[]'`    |
| `get`    | The entity directly                                      | `jq '.field'`      |
| `log`    | The session log array directly                           | `jq '.[]'`         |
| `patch`  | The patched entity                                       | `jq '.field'`      |
| `delete` | Void                                                     | —                  |

## Working with large payloads (`--out` pattern)

The headline win over MCP: pull to disk, jq locally, never truncate.

```bash
# Snapshot a window of sessions, then jq locally
evov session list --start-date 2026-05-01 --end-date 2026-05-10 --all --out .evo/sessions.json
jq '[.items[] | {id, customerName, fromAddress, toAddress, dateCompleted, outcome}]' .evo/sessions.json

# Pull one session — full untruncated log
evov session log <SID> --out .evo/log.json
jq -r '.[] | "\(.date)\t\(.message)"' .evo/log.json
```

When `--out` is set, stdout becomes `{"path":"<resolved>"}` so you can chain.

## Bulk scans: delegate to a sub-agent

For scans across many records ("every session whose log mentions 'timeout' across 1000 records"), spawn a sub-agent via the Task tool, hand it the on-disk path, ask for a narrow summary. Raw JSON never enters main context.

```bash
evov session list --start-date 2026-05-01 --end-date 2026-05-10 --all --out /tmp/s.json
# Then dispatch a sub-agent with a prompt like:
#   "Read /tmp/s.json — return id+fromAddress+outcome of any session whose
#    log array contains the word 'timeout'. Just the matches."
```

Rule of thumb: if jq output would exceed a screenful, delegate.

## Investigating a session log (the main use case)

The Evo Voice session object *is* the call log. It carries `dialState`, `callState`, `outcome`, `wasMissed`, `direction`, `fromAddress`/`toAddress`, full `log: [{date, message}]`, and the involved `accountId`, `customerId`, `endpointId`.

```bash
# 1. Find the session — by phone, customer, log text, parent session
evov session list --start-date 2026-05-09 --from "+15035551234" \
  --select id,fromAddress,toAddress,outcome,dateCompleted --plain
evov session list --customer-id <CID> --start-date 2026-05-01 --out /tmp/s.json
evov session list --log "timeout" --start-date 2026-05-01 --out /tmp/s.json

# 2. Pull the full log — untruncated
evov session log <SID> --out /tmp/log.json
jq -r '.[] | "\(.date)\t\(.message)"' /tmp/log.json | less

# 3. "Why did this call fail?" — combine session fields with log lines
evov session get <SID> --out /tmp/s.json
jq '{outcome, wasMissed, dialState, callState, ended, direction, log: (.log | length)}' /tmp/s.json
jq -r '.log[] | "\(.date)\t\(.message)"' /tmp/s.json | grep -iE 'error|fail|timeout|hangup'

# 4. Archived sessions (older than ~15 days — moved to ArchivedSession collection)
evov session list --archive --start-date 2026-03-01 --end-date 2026-03-15 ...
```

**Pagination:** lists default to `Page=0, CountPerPage=25`. Use `--all` for "give me everything matching" (heavy), or `--simplified-paging` to skip total counts (faster). To walk older windows: repeat with earlier `--start-date`/`--end-date`.

## Bulk-update endpoints (the second use case)

Two flavours: **staging clean** (one-shot loop) and **prod per-record** (each patch through the two-phase gate).

### Staging — the canonical loop

```bash
evov env use staging
evov whoami

# Pull, filter, patch
evov endpoint list --type User --customer-id <CID> --all --out /tmp/eps.json
jq '[.items[] | select(.userMode == "SoftPhone") | .id]' /tmp/eps.json > /tmp/ids.json

cat <<'JSON' > /tmp/patch.json
{ "managerAccess": "ReadOnly" }
JSON

# Preview first
for ID in $(jq -r '.[]' /tmp/ids.json); do
  evov endpoint patch "$ID" -f /tmp/patch.json --dry-run
done
# Then drop --dry-run to apply
for ID in $(jq -r '.[]' /tmp/ids.json); do
  evov endpoint patch "$ID" -f /tmp/patch.json
done
```

### Prod — per-record through the gate

On prod, each `evov endpoint patch` is its own phase-1 → confirm cycle. **Prescribed pattern:** quote a single *batch summary* to the user once, ask for one batch confirmation, then loop the `evov confirm` calls.

```bash
evov env use prod
evov whoami

# Phase 1: collect tokens (each patch returns one)
TOKENS=()
for ID in $(jq -r '.[]' /tmp/ids.json); do
  TOKEN=$(evov endpoint patch "$ID" -f /tmp/patch.json 2>/dev/null | jq -r '.token // empty')
  [ -n "$TOKEN" ] && TOKENS+=("$TOKEN")
done

# Now tell the user, verbatim:
# "About to PATCH 12 endpoints on Acme Corp PRODUCTION with {managerAccess:ReadOnly}.
#  Ids: ep_001, ep_002, ..., ep_012. Confirm to proceed?"

# After explicit user yes:
for T in "${TOKENS[@]}"; do
  evov confirm "$T"
done
```

If any phase-1 summary surfaces something unexpected (wrong account, weirder-than-expected endpoint), halt the batch.

**PATCH semantics on endpoints:**
- Sparse — only the fields you send are changed.
- BUT some nested objects (like `appSettings`, `assistantSettings`) may replace whole-cloth. Confirm by pulling, mutating with jq, pushing back if you're unsure.
- `IsPartialFlowUpdate: true` opts into partial `flowParams` merging — without it, `flowParams` is replaced.

## Troubleshooting

| Symptom                                       | Likely cause / fix                                                                  |
|-----------------------------------------------|-------------------------------------------------------------------------------------|
| 401 Unauthorized                              | Cookie expired or password changed. Run `evov auth login`.                          |
| 403 Forbidden                                 | Wrong account active for this resource. `evov whoami`, then `evov account use ...`. |
| 404 on a known session id                     | Likely archived (>15 days). Add `--archive` to `session list`.                      |
| Exit 11 / `requiresConfirmation: true`        | Prod write phase 1. Quote `summary`, wait for explicit yes, then `evov confirm`.    |
| `evov confirm` exit 4 "expired"               | 5-min TTL passed. Re-run phase 1 to get a fresh token.                              |
| `evov confirm` exit 4 "already consumed"      | Single-use token. Re-run phase 1.                                                   |
| `jq '.[]'` returns nothing on a `list`         | Use `jq '.items[]'`.                                                                |
| "NOTE: active account changed N min ago"      | Re-verify with the user before confirming the write.                                |
| `--account-name` override didn't switch       | By design — name-based overrides require `evov account use` for safety. Use `--account-id` for one-call overrides. |

## Agent introspection

```bash
evov schema --json
evov schema session list --json
evov exit-codes --json
```

## Exit codes

`0` ok · `1` err · `2` usage · `3` empty result · `4` auth · `5` not-found · `6` forbidden · `7` rate-limit · `8` retryable upstream · `9` not-impl · `10` config · **`11` confirmation-required**

## Reference

See [references/COMMANDS.md](references/COMMANDS.md) for the full per-command flag table.
