# evov — command reference

Full per-command reference. SKILL.md has the high-level rules and use-case patterns; this file has every flag.

## Global flags

Available on every subcommand.

| Flag                       | Purpose                                                                |
|----------------------------|------------------------------------------------------------------------|
| `-j, --json`               | Force JSON output (default when stdout is piped)                       |
| `-p, --plain`              | Tab-separated, top-level scalars only                                  |
| `--select <fields>`        | Comma list of top-level fields to keep (or `--fields`, alias)          |
| `--out <path>`             | Write JSON to `<path>`; stdout becomes `{"path":"<resolved>"}`         |
| `-n, --dry-run`            | Print planned `{method,url,body}` and exit 0 without calling the API   |
| `--no-input`               | Never prompt; fail if input is required                                |
| `--force`                  | Skip destructive-action confirmation (staging only)                    |
| `--yes`                    | Alias for `--force`                                                    |
| `-v, --verbose`            | Verbose progress to stderr                                             |
| `--quiet`                  | Suppress the env/account banner on stderr                              |
| `--env <name>`             | One-call env override (`prod` or `staging`)                            |
| `--account-id <id>`        | One-call override by id; a different tenant is refused while the idle guard is enabled |
| `--account-name <name>`    | (Reserved — name overrides require `evov account use`; see SKILL)      |

## Response shapes

| Command  | HTTP                                | Response shape                                         |
|----------|-------------------------------------|--------------------------------------------------------|
| `*  list`| `GET /<resource>`                   | `{items: T[], totalCount, totalPages, hasMorePages}`   |
| `*  get` | `GET /<resource>/{id}`              | `T`                                                    |
| `session log` | `GET /sessions?specificIds=id` | `T.log` (array of `{date, message}`)                   |
| `*  patch` | `PATCH /<resource>/{id}`          | `T` (the patched entity)                               |
| `session delete` | `DELETE /sessions`          | Void                                                   |
| `*  confirm` | (executes the stored phase-1)   | Same shape as the original `*` command would return    |

## auth

```
evov auth login   [--env prod|staging] [--user <email>] [--password <pw|->]
                  [--account-id <id> | --account-name <name>] [--no-input]
evov auth status  [--env prod|staging]
evov auth whoami  [--env prod|staging]
evov auth logout  [--env prod|staging]
```

- `login` POSTs `/auth/credentials` with `{provider:"credentials", userName, password, rememberMe:true}`, captures `ss-id`/`ss-pid` cookies, hits `/auth/status` to determine accessible accounts, prompts for account if >1 and not specified, persists, and confirms the tenant selected during login.
- `status` calls `/auth/status` with stored cookies; emits `{authenticated, env, user, accountId, accountName, availableAccounts}`. Exit 4 if session expired.
- `whoami` is a no-API-call snapshot of the persisted profile plus `tenantGuard` status. It does not extend tenant activity.
- `logout` clears stored cookies for the env (default: active env).

## env

```
evov env list
evov env use <prod|staging>
evov env current
```

- `list` returns one row per env with `{name, baseUrl, active, authenticated, accountId, accountName, user}`.
- `use` sets the persisted active env. If no profile exists yet for that env, a shell is created (you'll need `evov auth login` for it next).
- `current` prints `{env: "<name>"}`.

## account

```
evov account list                 [--env prod|staging]
evov account get [id]             [--env prod|staging]    (default: active account)
evov account use <nameOrId>       [--env prod|staging]
evov account confirm <nameOrId>   [--env prod|staging]
evov account guard [minutes|off]
evov account search [--name <text>] [pagination flags]    (SystemAdministrator)
evov account create -f <file|->                         (SystemAdministrator)
evov account patch <id> -f <file|->                    (SystemAdministrator)
evov account check <id>
evov account regenerate-tokens <id>
evov account delete <id> [--force on staging]
```

- `list` hits `/auth/status` and surfaces `accountIds`/`accountNames` with `active` flag — the source of truth for what the current user can access.
- `get` fetches `GET /accounts/{id}` for the full record.
- `use` validates `<nameOrId>` against the user's accessible accounts, updates the persisted active account, and clears tenant confirmation. Run `account confirm` after the user confirms the new tenant.
- `confirm` only accepts the exact active tenant id or a case-insensitive exact name. It records tenant confirmation/activity without changing tenants.
- `guard` shows or sets the global idle timeout. Default is 15 minutes; valid values are 1..1440 or `off`/`0`.
- `search` is the paginated `GET /accounts` administrator view; it is distinct from the current user's accessible-account `list`.
- Account create, patch, check, token regeneration, and delete are writes and use the production two-phase gate. Delete is destructive and requires `--force` on staging.

## session

```
evov session list   [filters and pagination flags below]
evov session get    <id>
evov session log    <id>                 (sugar: returns just .log)
evov session active                       (account-wide active Twilio calls)
evov session active-mine                  (signed-in phone user's active sessions)
evov session mine                         (sessions belonging to the current user)
evov session transcript <id> [--include-historical] [--historical-cut-off-date <date>]
evov session patch  <id>  -f <file|->    (PATCH /sessions/{id})
evov session create -f <file|->           (voice/chat/fax session)
evov session outgoing -f <file|->         (start an outgoing flow call)
evov session hold|redirect|add-log|message|invite-member|conference|add-conference-member <id> -f <file|->
evov session reject|record <id>
evov session end <id> [--call-sid <sid>] [--force on staging]
evov session remove-member <id> <memberId> [--force on staging]
evov session patch-conference-member <id> <callSid> -f <file|->
evov session delete --start-date-time <iso> --end-date-time <iso>
                                         (DELETE /sessions; bulk by date range on the active account)
```

`active` calls `GET /calls/active?accountId=...` and works account-wide. `active-mine` calls `GET /sessions/active` and requires the signed-in identity to match a phone-user endpoint. `session log [--archive]` intentionally uses the list route because the single-session backend route strips log entries.

### `session list` flags

| Flag                          | Maps to                       |
|-------------------------------|-------------------------------|
| `--archive`                   | `searchArchive=true`          |
| `--start-date <YYYY-MM-DD>`   | `startDate`                   |
| `--end-date <YYYY-MM-DD>`     | `endDate`                     |
| `--customer-id <id>` (rep)    | `customerIds`                 |
| `--endpoint-id <id>` (rep)    | `endpointIds`                 |
| `--from <text>`               | `from` (contains)             |
| `--to <text>`                 | `to` (contains)               |
| `--log <text>`                | `log` (text within log)       |
| `--parent-session-id <id>`    | `parentSessionId`             |
| `--specific-id <id>` (rep)    | `specificIds` — exact id match. Use this to pull a session WITH its log (GET /sessions/{id} returns log empty server-side). |
| `--page <n>`                  | `page` (0-based)              |
| `--count-per-page <n>`        | `countPerPage` (default 25)   |
| `--all`                       | `all=true`                    |
| `--simplified-paging`         | `simplifiedPaging=true`       |
| `--sort-field <f>`            | `sortField`                   |
| `--sort-order asc|desc`       | `sortOrder=Ascend|Descend`    |

Account is always passed as `accountIds=<active>` unless overridden by `--account-id`.

### `session patch` body

Fields supported by `PatchSession`:
- `consoleData` — string
- `callState` — `Disconnected | Ringing | Connected | Hold | Passive`
- `holdReason` — `None | Transferring`
- `queueState` — `None | Queued | Ringing | Connected | Hold | Disconnected`

### `session delete`

Bulk-only by design (the underlying DTO `DeleteSessions` has no single-id variant). Requires `--start-date-time` + `--end-date-time` (ISO8601). The active account is used unless `--account-id` overrides. Staging needs `--force`; prod goes through the two-phase gate.

Examples:
```bash
evov session list --start-date 2026-05-01 --end-date 2026-05-10 --all --out /tmp/s.json
evov session list --log "timeout" --start-date 2026-05-01 --out /tmp/s.json
evov session get $SID
evov session log $SID --out /tmp/log.json
echo '{"callState":"Hold"}' | evov session patch $SID -f -
```

## endpoint

```
evov endpoint list    [filters below]
evov endpoint get     <id>
evov endpoint patch   <id>  -f <file|->
```

### `endpoint list` flags

| Flag                       | Maps to                       |
|----------------------------|-------------------------------|
| `--customer-id <id>` (rep) | `customerIds`                 |
| `--flow-id <id>` (rep)     | `flowIds`                     |
| `--type <type>`            | `type` — one of `PhoneNumber, User, Team, Email, Fax, EmergencyAddress, SipTrunk, AssistantBot` |
| `--tag-id <id>` (rep)      | `tagIds` (must contain all)   |
| `--name <text>`            | `nameFilter`                  |
| `--phone-number <text>`    | `phoneNumberFilter`           |
| `--sip-user-name <text>`   | `sipUserName`                 |
| `--user-mode <mode>`       | `userMode`                    |
| (pagination flags)         | same as `session list`        |

### `endpoint patch` body

Sparse — only the fields you include are updated. See `PatchEndpoint` server DTO for the full surface (flow, flowParams, schedule, scheduledFlows, tagIds, name, managerAccess, dashboardPermissions, etc.). Note `isPartialFlowUpdate` opts into partial `flowParams` merging.

Examples:
```bash
evov endpoint list --type User --customer-id $CID --all --out /tmp/e.json
jq '.items | length' /tmp/e.json
echo '{"managerAccess":"ReadOnly"}' | evov endpoint patch $EID -f -
```

Endpoint coverage also includes `create <user|team|email|sip-trunk|assistant|phone-number>`, `delete`, `search-phone-numbers`, `sync-phone-numbers`, `set-fax`, `regenerate-sip-password`, `verify-caller-id`, `duplicates`, inherited/test schedules, and `provision-cogito`. Run `evov schema endpoint --json` for every flag.

## customer / flow

```bash
evov customer list|get|create|patch|delete ...
evov customer inherited-schedule <id>
evov customer set-staging|test-schedule <id> -f body.json

evov flow list|get|create|patch|copy|delete ...
evov flow available-nodes [flowId]
evov flow parameters [--exclude-built-in]
evov flow export [flowId...] --out package.json
evov flow import -f package.json
evov flow logic <id> [--all-values] [--out logic.json]
evov flow logic --file <flow-or-package.json>
evov flow validate <id>
evov flow validate --file <flow-or-package.json>
evov flow diff [leftId] [rightId] [--left-file <path>] [--right-file <path>]
evov flow impact <id>
evov flow node set <flowId> <node> <parameter> --value <json-or-text> [--source <source>] [--preview]
evov flow node add <flowId> -f node.json [--preview]
evov flow node remove <flowId> <node> [--disconnect-incoming] [--preview]
evov flow connect <flowId> <node> <transition> <target> [--preview]
evov flow disconnect <flowId> <node> <transition> [--preview]
evov flow edit <flowId> -f operations.json [--preview]
evov flow export-portable <id...> [--no-subflows] [--all-custom-fields|--no-custom-fields] --out portable.json
evov flow import-portable -f portable.json --preflight
evov flow import-portable -f portable.json [--map resource-map.json]
evov flow reconcile-portable -f portable.json [--map resource-map.json] [--flow <id-or-name>] [--preview]
evov flow blueprint list
evov flow blueprint add <name> -f portable.json [--revision <revision>] [--variables variables.json]
evov flow blueprint save <name> <flowId...> [--revision <revision>] [--variables variables.json] [portable export flags]
evov flow blueprint show <name> [--revision <revision>]
evov flow blueprint apply <name> [--revision <revision>] [--set name=value ...] [--map resource-map.json] [--preflight]
evov flow blueprint remove <name> [--revision <revision>] --force
```

Create/patch bodies use the server DTO's camelCase JSON fields. `customer create`, `flow create`, and `flow import` inject the active `accountId` when it is absent. Flow packages are JSON, not ZIP files.

`flow logic` removes empty/default node parameters, shows branches, subflows, resource dependencies, reachability, and missing targets, and redacts secret-like literal values. `--all-values` includes defaults but still redacts secret-like values. File-based logic/validation/diff can run locally without loading a flow from the API. `flow validate` mirrors the backend's important structural checks without writing. `flow diff` compares these compact representations instead of noisy UI/raw JSON.

Targeted edit commands fetch the current flow, mutate a copy, validate it, compute a secret-redacted semantic diff, and PATCH the complete resulting `nodes` array. Node selectors accept an exact id or a unique label. `--preview` performs the GET and emits validation/diff without writing; global `--dry-run` makes no API calls and can only show the planned GET/PATCH. Immediately before writing, the CLI hashes and rechecks the current nodes. The same precondition is stored in production confirmation tokens and checked again at confirmation time. A successful write is refetched and hash-verified; detected conflicts exit 12. The backend has no atomic conditional-PATCH/ETag support, so a very narrow race between the final check and PATCH remains. `node add` accepts a real node object and generates missing node/parameter ids. `node remove` refuses dangling inbound transitions unless `--disconnect-incoming` is explicit. Batch edit files contain an array (or `{ "operations": [...] }`) of `set`, `connect`, `disconnect`, `add-node`, and `remove-node` operations.

```json
[
  { "op": "set", "node": "dial", "parameter": "TimeoutInSeconds", "value": 45 },
  { "op": "connect", "node": "start", "transition": "OnFailure", "target": "voicemail" }
]
```

`flow impact` gives a compact reverse-dependency view: invoking flows, endpoints assigned to the target, outbound resource references, and a conservative `safeToDelete` flag. It cannot discover ids hidden in arbitrary strings.

The backend package endpoint refuses account-bound references such as teams, users, numbers, files, customers, and external flows. `export-portable` bypasses that exporter, records each reference's source ID, human name, and JSON path, and preserves the raw value. It recursively includes invoked subflows by default (`--no-subflows` disables this). It includes only custom fields actually used by the exported flows; use `--all-custom-fields` to include the whole account schema or `--no-custom-fields` to include none. `import-portable --preflight` loads destination resources, resolves unique exact-name matches, checks custom-field compatibility, validates source graphs, and detects duplicate destination flow names. Provide ambiguous or missing mappings as JSON:

```json
{
  "source-resource-id": "destination-resource-id",
  "Team:Support Team": "destination-team-id"
}
```

Invoked `/flows/start?flowId=...` subflows are included so the backend can remap them. Direct `Flow` parameter values still need an existing destination mapping. Backend imports do not preserve flow tags, customer assignments, descriptions, or flow roles; preflight reports those warnings. Portable packages retain credentials and other literal values needed by the flow—store them securely. Always run `--preflight` before importing into another account.

`--dry-run` and `--preflight` are intentionally different: dry-run makes no API calls and only prints the planned reads/write; preflight performs destination reads, exact-name resolution, custom-field compatibility checks, graph validation, and duplicate-name checks, but does not import. A normal import sends one `POST /packages` write after a successful preflight and has no transactional rollback because the backend does not provide one.

`reconcile-portable` restores descriptions, roles, customer assignment, and tag ids after import by exact destination names or explicit mappings. Always run `--preview` first. Production reconciliation is intentionally one flow per confirmation (`--flow`) because each PATCH is separately gated.

Blueprints are protected local portable packages under the Evo Voice config directory. Each named blueprint may have multiple revisions; omitting `--revision` on show/apply/remove selects the latest numeric-aware revision. `save` captures reviewed flows and recursive subflows; `show` emits redacted compact logic; `apply --preflight` performs the same destination checks as portable import. Generic built-in node definitions are not guessed; standard functionality should be saved from a flow already verified against the current backend node specifications.

Optional variable definitions are an array of `{name, path, description?, required?, default?, secret?}`. Paths must begin at `package` and point to an existing literal value. Account-resource-id paths are rejected because those must use `--map`. Apply values with repeatable `--set name=value`; JSON scalars are typed, while other text remains a string. Secret defaults are redacted by `blueprint show`.

## file / ai-session

```bash
evov file list [filters]
evov file get <id>
evov file upload <local-path> [--name <remote>] [--content-type <mime>] [--customer-id <id>]
evov file patch <id> [-f metadata.json] [--content <replacement-path>]
evov file delete <id> --force       # --force only on staging; prod uses phase 1/2

evov ai-session list|get|create|patch|apply|delete ...
evov ai-session clear-actions <id> --force
evov ai-session delete-action <id> <actionId> --force
evov ai-session usage --start-date <date> --end-date <date> [--customer-id <id>]
```

Multipart upload bytes are copied into the production pending action, so changing the source file after phase 1 cannot change what `confirm` sends.

## report / integration / sys

```bash
evov report list
evov report get <id>
evov report run <agent-state|billing|call-center-abandon|call-center-detail|call-center|call-history|call-outcome|cdr|metric|endpoints|sync-phone-numbers> [flags] [-f body.json]
evov report download <id> --out report.xlsx
evov report delete <id> --force

evov integration list|get|create|patch|delete ...
evov integration contacts|customers|log <id> ...
evov integration map-customer|map-user ...
evov integration sync <id>

evov sys log-entries [filters]
evov sys global-settings get|patch
evov sys settings get|patch
evov sys dialing-permissions list|patch
```

Reports are asynchronous: `run` returns a queued `ReportInfo`; poll `report list`/`report get`, then use `report download` once status is `Completed`.

## api

```
evov api <method> <path> [-d <json> | -f <file|-> | --upload <path>]
         [--upload-name <name>] [--upload-field <name>] [--content-type <mime>]
         [-q key=value ...] [--form key=value ...] [--download --out <path>] [--force]
```

Low-level escape hatch for internal callback routes and newly deployed endpoints. Same cookies and prod two-phase gate. Methods: GET/POST/PATCH/PUT/DELETE. Path may embed a query string; leading slash optional — **omit it under Git Bash** to dodge MSYS path conversion. Body via `-d`, `-f`, or `--upload`; multipart scalar fields use repeatable `--form`. `--download --out` preserves binary responses. GET with a body is a usage error. `DELETE` requires `--force` on every env.

## confirm

```
evov confirm <token>
```

Executes a stored phase-1 write request. Token is single-use, 5-min TTL. The pending request is bound to the env it was created against — switching env between phase 1 and phase 2 does not redirect the call.

| Failure                  | Exit | Fix                                  |
|--------------------------|------|--------------------------------------|
| Unknown token            | 4    | Re-run the original command          |
| Expired token            | 4    | Re-run the original command          |
| Already consumed         | 4    | Re-run the original command          |

## whoami / schema / exit-codes

```
evov whoami                      # shortcut for `evov auth whoami`
evov schema [path...] --json     # full or sub-tree command introspection
evov exit-codes --json           # exit-code map
```

## Environment variables

| Variable                 | Purpose                                                            |
|--------------------------|--------------------------------------------------------------------|
| `EVO_VOICE_CONFIG_DIR`   | Override config dir (default `~/.config/evo-voice`)                |
| `EVO_VOICE_CACHE_DIR`    | Override cache dir for `pending.json` (default `~/.cache/evo-voice`)|
| `EVO_VOICE_USER`         | Default `--user` for `auth login`                                  |
| `EVO_VOICE_PASSWORD`     | Default `--password` for `auth login`                              |
| `EVO_VOICE_NO_BANNER`    | Set to `1` to suppress the env/account banner globally             |
| `EVO_VOICE_TENANT_IDLE_MINUTES` | Override tenant idle timeout with 1..1440, 0, or `off`     |
| `EVO_VOICE_SMOKE_ACCOUNT` | Staging account used by `npm run test:staging-flow`                |
| `EVO_VOICE_SMOKE_SOURCE_FLOW_ID` | Existing flow copied into the disposable smoke flow        |

Exit 12 indicates a concurrent resource change or failed post-write state verification. For targeted flow edits, refetch and produce a new preview; do not retry the stale pending action.

Exit 13 emits `{requiresTenantConfirmation:true, account, env, reason, ...}`. Ask the user which tenant they intend and wait for their next response. Only then run `account confirm <exact-name-or-id>` and retry the blocked command. Context-management and explicitly local flow operations remain available while locked.

## Coverage matrix

First-class coverage is complete for auth, env, account, session, endpoint, customer, flow, file, AI session, report, integration, and system management. `api` supplies immediate coverage for internal callbacks and newly deployed routes. Use `evov schema [resource] --json` as the authoritative command reference.
