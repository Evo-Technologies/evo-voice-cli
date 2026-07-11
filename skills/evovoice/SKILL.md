---
name: evovoice
description: Manage the full Evo Voice operator API via the evov CLI — sessions and logs, endpoints and numbers, customers, flows, files, AI sessions, reports, integrations, system settings, accounts, and environments. Use whenever the user asks to inspect or change Evo Voice data.
allowed-tools: Bash(evov *), Bash(jq *), Bash(cat *), Bash(echo *), Bash(date *)
---

# evov — Evo Voice CLI

Thin wrapper over the Evo Voice REST API (ServiceStack on `evovoice.io` / `team.evovoice.io`). Designed so you can dump JSON to disk and process it with `jq`. **List responses are wrapped — use `jq '.items[]'`, not `jq '.[]'`.**

## ⚠ Safety rules — read first

Account-scoped reads and writes run only while the tenant context is confirmed and inside its idle window.
Writes on **STAGING**: run directly. Destructive delete commands require `--force`.
Writes on **PRODUCTION**: two-phase confirmation (below).

### Idle tenant protocol (exit 13)

The tenant guard defaults to 15 minutes without account-scoped CLI activity. When a command exits 13 and stdout contains `{requiresTenantConfirmation:true, account, env, reason, ...}`:

1. **Tell the user the exact tenant name/id and environment from the payload.**
2. **Ask which tenant they intend to use.**
3. **Wait for the user's NEXT message.** Never infer tenant confirmation from an older request or from the active CLI profile.
4. If their answer matches the active tenant, run `evov account confirm "<exact-name-or-id>"`, then retry the blocked command.
5. If they name another tenant, run `evov account use "<name-or-id>"`, show them the resulting tenant, wait for confirmation if it was not already explicit in that new message, then run `account confirm`.

Do not run `account confirm` merely because the error told you which tenant was active. The human confirmation is the point of the gate. `whoami`, account list/use/confirm/guard, auth/env management, schema, and local flow-file/blueprint inspection remain available while locked and do not silently extend tenant activity.

Configure with `evov account guard <minutes>` (1..1440); `off` explicitly disables it. `EVO_VOICE_TENANT_IDLE_MINUTES` is an environment override. Different-tenant `--account-id` one-call overrides are refused while enabled; switch and reconfirm instead.

### Two-phase protocol (prod writes)

When you run a write (create / update / delete) on the **prod** env and the CLI exits 11 with stdout `{requiresConfirmation: true, token, summary, account, ...}`:

1. **Quote the `summary` field VERBATIM in your reply** to the user. Do not paraphrase.
2. **Ask explicitly**: "Confirm to proceed on this account/env?"
3. **Wait for an affirmative reply in the user's NEXT message.** Do NOT infer confirmation from anything said earlier in the conversation — even if the user previously said "go ahead with all this." Each phase-1 needs its own fresh "yes".
4. **Only then** run `evov confirm <token>`.
5. If the user says no or asks for changes: do NOT run `evov confirm`. The token expires in 5 minutes. Re-run phase 1 with new params if they want to retry.

If `evov confirm <token>` itself exits 13, the token has not executed. Follow the idle tenant protocol, then retry the token if it has not expired.

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
evov account confirm "Acme Corp"     # only after the user confirms this exact tenant
evov --env staging session list ...  # one-call env override
```

After every switch, run `evov whoami`, show/read the tenant, obtain the user's confirmation, and run `account confirm`. Never chain an account-scoped command after a switch without this step.

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

When `--out` is set, stdout becomes `{"path":"<resolved>"}` so you can chain. JSON and binary output files are created with owner-only permissions (mode 600) where the platform supports it.

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

**Server quirk:** `GET /sessions/{id}` returns the session with `log: []` empty — the log is only populated in **list** responses. `evov session log <id>` works around this by calling `GET /sessions?specificIds=<id>` and extracting the first item's log. Use `evov session log` instead of `session get | jq .log`.

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

## Full API command surface

First-class groups exist for `account`, `session`, `endpoint`, `customer`, `flow`, `file`, `ai-session`, `report`, `integration`, and `sys`. Discover exact current operations and flags before an unfamiliar task:

```bash
evov schema --json
evov schema customer --json
evov schema report run --json
```

See `references/COMMANDS.md` for the condensed command guide.

### Flow engineering workflow

Do not load a full flow into the conversation unless raw node JSON is specifically needed. Start with the compact, secret-redacted logic graph:

```bash
evov flow logic "$FLOW_ID" --out /tmp/flow-logic.json
jq '{flow,nodes,stats,warnings,references}' /tmp/flow-logic.json
evov flow validate "$FLOW_ID"
```

Before changing a shared flow, inspect its callers and assigned endpoints:

```bash
evov flow impact "$FLOW_ID"
```

Prefer targeted edit commands. They fetch the current graph, mutate a copy, validate it, show a compact semantic result, and PATCH the complete nodes array safely:

```bash
evov flow node set "$FLOW_ID" start Timeout --value 45 --preview
evov flow connect "$FLOW_ID" start OnFailure voicemail --preview
# Repeat without --preview only after reviewing valid=true and the semantic diff.
```

Targeted writes carry a hash of the nodes they were based on. The CLI checks it immediately before PATCH, stores it inside production confirmation tokens, checks it again when `evov confirm` executes, then refetches and verifies the intended graph. Exit 12 means the graph changed concurrently or the server did not persist the intended result; refetch and start over rather than forcing the stale patch. This is best-effort concurrency protection because the backend exposes no atomic conditional PATCH/ETag; a narrow check-to-write race cannot be eliminated client-side.

Use `flow edit -f operations.json --preview` to combine several `set`, `connect`, `disconnect`, `add-node`, or `remove-node` operations into one validated PATCH. Node removal blocks dangling inbound transitions unless `--disconnect-incoming` is explicit. Node addition must use a real backend-compatible node object; missing ids are generated.

For graph transformations not expressible as targeted operations, compare the intended full version structurally:

```bash
evov flow get "$FLOW_ID" --out /tmp/before.json
# Create /tmp/after.json locally without printing it into chat.
evov flow validate --file /tmp/after.json
evov flow diff --left-file /tmp/before.json --right-file /tmp/after.json
```

Remember that `nodes`, `parameters`, `exits`, and `roles` replace their complete arrays when present in `flow patch`; they do not merge. Use sparse patches for scalar changes. For graph changes, start from the current full arrays, modify them locally, validate, then patch.

For cross-account movement, use portable packages—not the backend package command—when any node references account resources:

```bash
evov flow export-portable "$FLOW_ID" --out /tmp/portable.json  # invoked subflows included recursively
evov flow import-portable -f /tmp/portable.json --preflight
# Supply --map mappings.json if preflight reports unresolved/ambiguous resources.
evov flow import-portable -f /tmp/portable.json --map mappings.json
```

Treat a reviewed portable package as reusable common functionality with `flow blueprint save/list/show/apply`. Use explicit `--revision` values for production patterns. Optional `--variables` definitions point to literal package paths; supply values through repeatable `--set name=value`. Resource IDs remain mappings, not variables. Preflight separately in every destination account because resource names, custom-field schemas, and existing flow names are account-specific. `--dry-run` only describes the requests; `--preflight` performs the read-only destination resolution and compatibility checks.

Portable exports and saved blueprints contain the original literal values, potentially including credentials. Keep them out of chat and protect the files. Tags, customer assignments, descriptions, and flow roles are not preserved by the backend package importer. After import, run `flow reconcile-portable -f ... --preview`, then apply it; on production select one flow at a time with `--flow` so every metadata PATCH receives its own confirmation.

## Low-level API escape hatch (`evov api`)

For internal callback routes or endpoints deployed after this CLI release, use `evov api` instead of curl or ad-hoc scripts — it rides the same stored cookies and the same prod two-phase gate:

```bash
evov api GET "flows?accountIds=$AID"             # query embedded in path works
evov api GET calls/active -q accountId="$AID"     # account-wide active calls
evov api POST customers -d '{"accountId":"...","name":"Harness"}'
evov api POST flows -f newflow.json               # large bodies (>32KB) via file
evov api POST files --upload audio.wav --content-type audio/wav --form accountId="$AID"
evov api GET "reports/$RID.xlsx" --download --out report.xlsx
evov api PATCH "sessions/$SID" -d '{"callState":"Disconnected"}'
evov api DELETE "sessions/$SID" --force           # DELETE always requires --force
```

Rules:
- **Omit the leading slash on paths** (`sessions/active`, not `/sessions/active`) — under Git Bash, MSYS converts leading-slash args into Windows paths. The CLI detects the mangled form and tells you, but omitting the slash avoids it entirely.
- Do NOT use curl against evovoice.io — the server rejects it. `evov api` is the sanctioned raw-access path.
- Writes on prod behave exactly like every other command: phase-1 summary + exit 11 + `evov confirm <token>`.
- Discover request/response shapes from the Voice API source (`Voice/src/Voice.Api/**/*.cs` — DTOs carry `[Route]` attributes) when unsure.

## Troubleshooting

| Symptom                                       | Likely cause / fix                                                                  |
|-----------------------------------------------|-------------------------------------------------------------------------------------|
| 401 Unauthorized                              | Cookie expired or password changed. Run `evov auth login`.                          |
| 403 Forbidden                                 | Wrong account active for this resource. `evov whoami`, then `evov account use ...`. |
| 404 on a known session id                     | Likely archived (>15 days). Add `--archive` to `session list`.                      |
| Exit 11 / `requiresConfirmation: true`        | Prod write phase 1. Quote `summary`, wait for explicit yes, then `evov confirm`.    |
| Exit 13 / `requiresTenantConfirmation: true`  | Show the tenant, ask the user which tenant, wait, then run `account confirm`.       |
| `evov confirm` exit 4 "expired"               | 5-min TTL passed. Re-run phase 1 to get a fresh token.                              |
| `evov confirm` exit 4 "already consumed"      | Single-use token. Re-run phase 1.                                                   |
| Exit 12 / concurrent-change conflict           | Refetch the flow, review a new preview/diff, and rerun the targeted edit.           |
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

`0` ok · `1` err · `2` usage · `3` empty result · `4` auth · `5` not-found · `6` forbidden · `7` rate-limit · `8` retryable upstream · `9` not-impl · `10` config · **`11` production confirmation required** · **`12` concurrent-change/verification conflict** · **`13` tenant reconfirmation required**

## Reference

See [references/COMMANDS.md](references/COMMANDS.md) for the full per-command flag table.
