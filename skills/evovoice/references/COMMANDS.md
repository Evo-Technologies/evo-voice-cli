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
| `--account-id <id>`        | One-call active-account override by id                                 |
| `--account-name <name>`    | (Reserved — name overrides require `evov account use`; see SKILL)      |

## Response shapes

| Command  | HTTP                                | Response shape                                         |
|----------|-------------------------------------|--------------------------------------------------------|
| `*  list`| `GET /<resource>`                   | `{items: T[], totalCount, totalPages, hasMorePages}`   |
| `*  get` | `GET /<resource>/{id}`              | `T`                                                    |
| `session log` | `GET /sessions/{id}`           | `T.log` (array of `{date, message}`)                   |
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

- `login` POSTs `/auth/credentials` with `{provider:"credentials", userName, password, rememberMe:true}`, captures `ss-id`/`ss-pid` cookies, hits `/auth/status` to determine accessible accounts, prompts for account if >1 and not specified, persists.
- `status` calls `/auth/status` with stored cookies; emits `{authenticated, env, user, accountId, accountName, availableAccounts}`. Exit 4 if session expired.
- `whoami` is a no-API-call snapshot of the persisted profile (env, account, user, accountChangedAt, authenticated).
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
```

- `list` hits `/auth/status` and surfaces `accountIds`/`accountNames` with `active` flag — the source of truth for what the current user can access.
- `get` fetches `GET /accounts/{id}` for the full record.
- `use` validates `<nameOrId>` against the user's accessible accounts, then updates the persisted active account. Sets `accountChangedAt` — phase-1 will warn if a write happens within 5 minutes.

## session

```
evov session list   [filters and pagination flags below]
evov session get    <id>
evov session log    <id>                 (sugar: returns just .log)
evov session patch  <id>  -f <file|->    (PATCH /sessions/{id})
evov session delete --start-date-time <iso> --end-date-time <iso>
                                         (DELETE /sessions; bulk by date range on the active account)
```

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

## Coverage matrix

| Resource     | Status     | Commands                              |
|--------------|------------|---------------------------------------|
| auth         | Phase 1 ✅ | `login`, `status`, `whoami`, `logout` |
| env          | Phase 1 ✅ | `list`, `use`, `current`              |
| account      | Phase 1 ✅ | `list`, `get`, `use`                  |
| session      | Phase 1 ✅ | `list`, `get`, `log`, `patch`, `delete` |
| endpoint     | Phase 1 ✅ | `list`, `get`, `patch`                |
| confirm      | Phase 1 ✅ | `confirm <token>`                     |
| customer     | Phase 2 ⏳ | —                                     |
| flow         | Phase 2 ⏳ | —                                     |
| file         | Phase 3 ⏳ | —                                     |
| ai-session   | Phase 3 ⏳ | —                                     |
| report       | Phase 3 ⏳ | —                                     |
| sys          | Phase 4 ⏳ | —                                     |
