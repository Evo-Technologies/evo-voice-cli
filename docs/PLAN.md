# Evo Voice CLI — Plan

`evo-voice-cli` (binary: `evov`). A thin CLI over the Evo Voice REST API for humans and AI agents — mirrors the [Better-Vapi-CLI](https://github.com/EvoTechMike/Better-Vapi-CLI) pattern (which is itself the qbo-cli pattern). Goal: let Claude work with large data (full session logs, full transcripts, bulk endpoint updates) without truncation, without an MCP server in the loop.

> Status: planning. No code yet. Source for study: `C:\Clients\Evo\Voice` (Evo Voice server) and `\\wsl$\Ubuntu-22.04\home\clients\evo\vapi-better-cli` (sibling CLI to mirror).

---

## 1. Context — what the Evo Voice API actually looks like

Verified by reading `C:\Clients\Evo\Voice\src\Voice.Api\**` and `C:\Clients\Evo\Voice\src\Voice.Web\AppHost.cs`:

- **Stack:** ServiceStack 6 on .NET, MongoDB-backed. All endpoints are decorated DTOs (`[Route("/sessions","GET")]` etc.) — so the API surface is enumerable from the source.
- **Production:** API at `https://evovoice.io` (same origin as the dashboard — confirmed with Mike).
- **Staging:** API at `https://team.evovoice.io` (same origin as the staging dashboard).
- **Auth model (this is the big departure from Vapi):**
  - No API keys. ServiceStack `AuthFeature` is wired with `BasicAuthProvider` + `CredentialsAuthProvider` + `McpAuthProvider`.
  - The dashboard signs in by `POST /auth/credentials` with `{provider:"credentials", userName, password, rememberMe:true}` → ServiceStack sets `ss-id` / `ss-pid` cookies (and `ss-opt` if rememberMe), then subsequent calls send the cookies.
  - **Basic auth also works** — the server accepts `Authorization: Basic base64(user:pass)` on every request (no cookie needed). That's the simplest credential model for a CLI.
  - Both modes give the same session/permissions surface.
- **Multi-account is a first-class concept:**
  - A user (UserAuth) has `Roles` and via those Roles is granted access to one or more `AccountId`s (see `Account.RolesToAccounts(session.Roles)` in `AuthenticationService.cs`).
  - `GetAuthStatus` returns `accountIds: string[]` + `accountNames: string[]` for the authenticated user.
  - The dashboard stores the chosen account in `localStorage.accountId` and threads it through every request as a query param (`?accountIds=...` on list endpoints, `?accountId=...` on single-resource endpoints like `DeleteSessions`).
  - **System Administrators see every account** (the auth status returns *all* accounts in the DB, not just role-granted ones).
- **Response shape (also a departure from Vapi):**
  - **Lists are wrapped:** `ListRequest<T>` → `ListResponse<T> = { items: T[], totalCount, totalPages, hasMorePages }`. Not bare arrays like Vapi.
  - **Pagination is Page/CountPerPage** (default `Page=0`, `CountPerPage=25`), with optional `All=true` (use sparingly) and `SimplifiedPaging=true` (no totals — faster).
  - Get/Create/Update return the entity directly.
  - Delete returns void.
- **JSON serialization:** camelCase top-level keys (set in `AppHost.ConfigJsonSerialization`), so e.g. `{ "accountId": ..., "items": [...] }`.

### Resources we care about (verified from `src/Voice.Api/`)

| Resource     | Route                       | Notes                                                                                       |
|--------------|-----------------------------|---------------------------------------------------------------------------------------------|
| auth         | `/auth/credentials`, `/auth/status`, `/auth/logout` | `Authenticate { provider, userName, password, rememberMe }` POST/GET pattern    |
| accounts     | `/accounts`, `/accounts/{id}` | List/Get/New/Patch/Delete/Check/RegenerateTokens                                            |
| sessions     | `/sessions`, `/sessions/{id}` | **The marquee one.** List has `SearchArchive` (live vs archived), `Log` text search, dates, customers, endpoints, from/to. `SessionInfo.Log: SessionLogInfo[]` = `{Date, Message}[]` — the actual logs. |
| endpoints    | `/endpoints`, `/endpoints/{id}` | Phone numbers, users, teams, SIP, email. **Marquee for bulk updates.** PATCH supports a huge surface (flow, schedule, tags, name, permissions, etc.). |
| customers    | `/customers`                  | Hierarchical (parent/child).                                                                |
| flows        | `/flows`, `/flows/{id}`       | Voice flows (the IVR-style graph).                                                          |
| files        | `/files`, `/files/{id}`       | File store (multipart upload).                                                              |
| reports      | `/reports`                    | Call history, CDR, agent state, billing — async-generated.                                  |
| ai/sessions  | `/ai/sessions` (verify)       | AI/MCP chat sessions — `AISessionInfo`, list/get/new/patch/delete/apply.                    |
| sys          | `/sys/log-entries`, `/sys/global-settings` | System logs and global settings (SystemAdmin only).                                 |

(Full coverage of every endpoint in `Voice.Api` exists; phases below.)

---

## 2. Why a CLI (the standard pattern)

- **Bypass MCP truncation.** A full session log can be hundreds of entries — MCP truncates, jq doesn't.
- **`--out <file>` keeps raw JSON out of Claude's context window.** Stdout gets `{"path":"..."}` and the data lives on disk for jq.
- **Skill teaches Claude the shape.** `skills/evovoice/SKILL.md` tells the agent "the response shape is `{items:[]}` — that's why you `jq '.items[] | ...'`, not `jq '.[] | ...'`."
- **Single source of truth.** One CLI used by Mike interactively and by Claude programmatically — same flags, same behavior.

---

## 3. The multi-account safety problem (Mike's explicit concern)

> "an auth credential can have access to more than one account so we need to make sure its clear what account is being worked on as that could lead to costly mistakes if a command given on the wrong account."

The real failure mode (clarified with Mike): a human asks the LLM to *"do X"* mid-conversation. The LLM was previously set to a different account. It dutifully writes the command using its persisted state — and any flag-based safety the LLM also fills in will match its own (wrong) state. The gate has to route through the human, not through anything the LLM constructs.

### Design: two-phase confirmation for all writes on production

Reads (`list`, `get`, `log`, `whoami`, `status`) are unaffected — no friction for the 90% case. Writes (POST / PATCH / DELETE) on the **prod** environment go through a two-phase flow:

**Phase 1** — the natural command:
```
evov session delete --start-date-time 2026-05-01 --end-date-time 2026-05-10
```
The CLI does **not** execute. It stores the planned request in `~/.cache/evo-voice/pending.json` (TTL 5 min) under a fresh random opaque token, then exits with code 11 (`CONFIRMATION_REQUIRED`).

Stdout (JSON, for the agent to parse):
```json
{
  "requiresConfirmation": true,
  "token": "zX9k2pQa",
  "expiresAt": "2026-05-11T17:23:00Z",
  "action": "DELETE /sessions",
  "env": "prod",
  "account": { "id": "5f8e...", "name": "Acme Corp" },
  "summary": "Delete sessions for Acme Corp on PRODUCTION between 2026-05-01 and 2026-05-10",
  "estimatedAffected": 142
}
```

Stderr (human-readable; doubles as the LLM's instruction):
```
⚠ PRODUCTION write requires confirmation.
  Action:  DELETE /sessions
  Account: Acme Corp (5f8e...)
  Range:   2026-05-01 → 2026-05-10  (~142 sessions)

Show this summary to the user, get explicit confirmation that this is
the right account and action, then run:
    evov confirm zX9k2pQa
Token expires in 5 minutes.
```

**Phase 2** — confirmation:
```
evov confirm zX9k2pQa
```
Looks up the stored request, verifies token + TTL, executes the exact same call. The LLM cannot change parameters between phases — they're stored locally and bound to the token.

### Why this catches the failure mode

- Phase-1 stderr/stdout names the target account *in human prose* (`"Acme Corp"`). When the human asks "do X" meaning Beta but Claude is on Acme, the summary surfaces "Acme Corp" back into the chat. The human reads it and stops the action before phase 2 ever runs.
- Tokens are random nonces, single-use, time-limited. The LLM can't carry one over from earlier in the conversation or fabricate one — it must come from a fresh phase-1 call.
- Parameters are bound to the token. The LLM literally cannot mutate the request between phases.

### Skill-level rule paired with the CLI gate

The skill's loudest rule: when Claude sees `requiresConfirmation: true`, it MUST quote the `summary` field verbatim back to the user and wait for an affirmative reply in the **current message** before running `evov confirm`. Not "you said yes earlier" — explicit yes for this specific action.

### Staging is recoverable, so no two-phase gate

Writes on staging (`team.evovoice.io`) run immediately. Delete operations still require `--force` (matches bvapi convention). The skill instructs Claude to echo the env+account in chat before any staging write too, but there's no CLI gate — just a banner.

### Banner on every call (read and write)

Every command prints a one-line banner to **stderr** before doing work:
```
[PROD] evovoice.io · acct=Acme Corp (5f8e...) · user=mike@evo.tech
```
Production tinted red, staging tinted yellow when stderr is a TTY. Suppressible with `--quiet`. Stdout stays clean for piping.

### Active-account-change marker

`evov account use <name>` stamps a `changedAt` timestamp on the profile. If the next phase-1 happens within N minutes of an `account use`, stderr prepends `NOTE: active account was changed N minutes ago — re-verify with the user.` Belt + suspenders for the exact failure mode Mike described.

### Summary of prod-write flow

| Step                                       | Behavior                                                                       |
|--------------------------------------------|--------------------------------------------------------------------------------|
| Phase 1: `evov session delete ...`         | No execution. Exits 11. Stdout = JSON summary. Stderr = human-readable summary + next command. |
| Human reads summary, confirms in chat      | LLM only proceeds on explicit confirmation in the current message.             |
| Phase 2: `evov confirm <token>`            | Executes the stored request exactly.                                           |
| Token expired or already used              | Exit 4 (`AUTH`-like) with "token expired/unknown; re-run phase 1".              |

---

## 4. Environment switching

Two named environments, each its own profile with its own cookies and active account.

```bash
evov env list                # show both, mark active one + auth state
evov env use prod            # switch persisted active env
evov env use staging         # switch persisted active env
evov env current             # print just the active env name
```

Example:
```
$ evov env list
  prod     evovoice.io        authenticated  (acct: Acme Corp)
* staging  team.evovoice.io   authenticated  (acct: Acme Test)

$ evov env use prod
Active env: prod (evovoice.io) — acct: Acme Corp
```

`evov auth login` defaults to the active env; `--env prod|staging` overrides for one call. So the canonical flow is:

```bash
evov env use staging         # switch
evov auth login              # log into staging if not yet
evov session list            # work on staging — no confirm needed for reads

evov env use prod            # switch
evov auth login              # log into prod if not yet
evov session delete ...      # phase 1 — exits 11 with confirmation summary
evov confirm zX9k2pQa        # phase 2 — runs on prod
```

A single command-level override exists for surgical use: `evov --env staging session list ...` runs that one call against staging without changing the persisted active env. Used rarely; banner makes the override visible.

Config schema (mode 600):
```json
{
  "activeEnv": "prod",
  "envs": {
    "prod":    { "baseUrl": "https://evovoice.io",       "user": "...", "cookies": {...}, "accountId": "...", "accountName": "...", "accountChangedAt": "..." },
    "staging": { "baseUrl": "https://team.evovoice.io",  "user": "...", "cookies": {...}, "accountId": "...", "accountName": "...", "accountChangedAt": "..." }
  }
}
```

---

## 5. Architecture

Single-package TypeScript, distributed via npm. Matches `bvapi` so Mike (and Claude reading the skill) gets the same muscle memory.

```
evo-voice-cli/
├── package.json              # bin: { evov: ./dist/cli.js }, type:module, node>=18
├── tsconfig.json
├── tsup.config.ts
├── README.md
├── src/
│   ├── cli.ts                # commander root
│   ├── bin.ts                # entry shim (matches bvapi)
│   ├── config.ts             # env profiles, cookies, active account, pending-actions cache
│   ├── http.ts               # ssFetch(method, path, {query, body}); read = direct, write = phase-1
│   ├── output.ts             # emit(): JSON/TSV/--select/--out/banner
│   ├── exit-codes.ts         # 0..11 (adds CONFIRMATION_REQUIRED=11)
│   ├── schema.ts             # `evov schema` introspection
│   ├── global-flags.ts       # --json, --plain, --select, --out, --dry-run, --no-input,
│   │                         #   --force, --verbose, --quiet, --account-id, --account-name, --env
│   └── commands/
│       ├── auth.ts           # login | status | logout | whoami
│       ├── env.ts            # list | use | current
│       ├── account.ts        # list | get | use
│       ├── confirm.ts        # confirm <token>
│       ├── session.ts        # list | get | log | patch | delete       (the marquee)
│       ├── endpoint.ts       # list | get | patch                      (the marquee for bulk)
│       ├── customer.ts       # list | get | patch
│       ├── flow.ts           # list | get | patch | (export/import?)
│       ├── file.ts           # list | get | upload | delete
│       ├── report.ts         # list | get | run     (reports are async-generated)
│       └── ai-session.ts     # list | get | new | patch | delete
├── skills/
│   └── evovoice/
│       ├── SKILL.md          # mirrors bvapi/SKILL.md depth (~250 lines)
│       └── references/
│           └── COMMANDS.md   # per-command flag table
└── tests/
    ├── http.test.ts          # mocked fetch — cookies, error→exit
    ├── auth.test.ts          # login flow, account picker
    ├── confirm.test.ts       # phase-1/phase-2 token gate, TTL, single-use
    └── session.test.ts       # list/get/log, banner, prod-write goes through gate
```

### Differences from `bvapi` (where the Evo Voice API forces our hand)

| Concern              | `bvapi` (Vapi)                    | `evov` (Evo Voice)                                                   |
|----------------------|-----------------------------------|----------------------------------------------------------------------|
| Credential model     | Bearer API key                    | Username + password → cookie (no password at rest)                   |
| Account scoping      | Key = org. No ambiguity.          | User has N accounts. **Active account is state, banner shows it.**   |
| Environment          | Single host (`api.vapi.ai`)       | Two named envs: prod + staging                                       |
| List response        | `T[]`                             | `{items: T[], totalCount, totalPages, hasMorePages}`                 |
| Pagination           | `--limit` only                    | `--page`, `--count-per-page`, `--all`, `--simplified-paging`         |
| Date filters         | `--created-at-gt` ISO             | `--start-date`, `--end-date` (YYYY-MM-DD for sessions)               |
| Banner               | None                              | Mandatory account/env banner on stderr                               |
| Write confirmation   | `--force` on delete               | Prod writes are two-phase (`evov ... cmd` → exit 11, `evov confirm <token>`); staging writes need `--force` on delete only |

`emit()`/`--select`/`--out`/`--dry-run` semantics carry over unchanged. The skill's "pipe to jq" workflow becomes `evov session list --out /tmp/s.json && jq '.items[] | ...' /tmp/s.json` — one extra `.items` step the skill will spell out.

### Auth flow in detail

Decision: **cookies, no password at rest.**

`evov auth login`:
1. Read `--user` and `--password` (or `--password -` for stdin, or prompt interactively if neither — same UX as `gh auth login`).
2. Target env = `--env` flag if given, else persisted active env.
3. `POST {baseUrl}/auth/credentials` with `{provider:"credentials", userName, password, rememberMe:true}`. Capture `Set-Cookie` values (`ss-id`, `ss-pid`, optionally `ss-opt`).
4. `GET {baseUrl}/auth/status` with the cookies. If `accountIds.length > 1`:
   - Interactive: render a numbered list, prompt.
   - `--account-id <id>` or `--account-name <name>`: use directly.
   - `--no-input` without account flag: error → exit 2 (USAGE) listing available accounts.
5. Persist into the env's profile (see schema in §4).
6. If the cookie is rejected mid-session (`401`), the CLI surfaces a single clear "session expired, run `evov auth login`" error — exit 4 AUTH. No auto-re-login (would require storing the password).

---

## 6. Phase plan

Each phase a separate PR. Phase 1 must ship the spine (auth + multi-account safety + sessions) before anything else.

### Phase 1 — foundation + sessions + endpoints (the marquee)

The user's two stated use cases. Everything below is in this PR.

- **Build & package**: `package.json` (`bin: { evov: ./dist/cli.js }`), `tsup` bundle, Node 18+.
- **`config.ts`**: env profiles, cookies, active account, mode-600 file. Also owns the pending-actions cache (`~/.cache/evo-voice/pending.json`).
- **`http.ts`**: cookie jar, retry on 429/5xx (1s backoff), status→exit-code mapping (401→AUTH, 403→FORBIDDEN, 404→NOT_FOUND, 429→RATE_LIMIT, 5xx→RETRYABLE). Banner emitted before every request. Write methods on prod short-circuit into the phase-1 flow — they don't hit the API, they record a pending action and exit 11.
- **`output.ts`**: `emit()` clone of bvapi's, plus banner-to-stderr support; `--select` works on `.items[]` when the response is a `ListResponse`.
- **`commands/auth.ts`**: `login | status | logout | whoami`.
- **`commands/env.ts`**: `list | use <prod|staging> | current`.
- **`commands/account.ts`**: `list | get | use <name|id>`. `use` records `accountChangedAt` for the warning marker.
- **`commands/confirm.ts`**: `confirm <token>` — looks up the pending action, verifies TTL + single-use, executes the stored request.
- **`commands/session.ts`** — the marquee:
  - `list` — wraps `GET /sessions`. Flags: `--account-id`/`--account-name` (else uses active), `--archive` (`SearchArchive=true`), `--start-date YYYY-MM-DD`, `--end-date YYYY-MM-DD`, `--customer-id` (repeatable), `--endpoint-id` (repeatable), `--from`, `--to`, `--log <text>` (full-text search inside `Log[]`), `--parent-session-id`, `--page N`, `--count-per-page N`, `--all`, `--simplified-paging`, `--sort-field`, `--sort-order asc|desc`. Unwraps `ListResponse.items` by default; `--raw` keeps the wrapper.
  - `get <id>` — `GET /sessions/{id}`. Returns the full session including `log: [{date, message}]`.
  - `log <id>` — convenience that fetches the session and emits just `.log` (with `--out`-friendly behavior).
  - `patch <id>` — `PATCH /sessions/{id}` with body from `-f`. Console data, call state, hold reason, queue state. On prod → phase 1.
  - `delete` — `DELETE /sessions` (bulk; takes `--account-id`, `--start-date-time`, `--end-date-time` per the DTO). On prod → phase 1; on staging requires `--force`. (Single-session deletion isn't a documented route in `Sessions/` — `DeleteSessions` is bulk-only.)
- **`commands/endpoint.ts`** — the marquee for bulk updates. Subcommands: `list | get | patch`. List filters mirror the C# DTO: `--account-id`, `--customer-id`, `--flow-id`, `--type assistant|user|team|...`, `--tag-id`, `--name`, `--phone-number`, `--sip-user-name`, plus the pagination flags. Patch takes JSON body via `-f` so bulk loops on staging are `evov endpoint list ... --out /tmp/e.json && jq '.items[] | {id}' /tmp/e.json | xargs ... evov endpoint patch ID -f patch.json`. On prod, each individual `patch` is its own phase-1/phase-2 — bulk on prod has to be explicitly orchestrated and acknowledged per record.
- **`commands/schema`** + **`exit-codes`** — same as bvapi, for agent introspection. `exit-codes` includes `11 CONFIRMATION_REQUIRED`.
- **Skill** — `skills/evovoice/SKILL.md` + `references/COMMANDS.md`. Spec'd in §7 below.

### Phase 2 — customer, flow

CRUD subcommands for `/customers` and `/flows`. Flows have the most interesting surface (`ExportPackage` / `ImportPackage` are the bulk operations — those become `evov flow export <id> --out flow.zip` / `evov flow import -f flow.zip`).

### Phase 3 — file, ai-session, report

Files: multipart upload (isolated in `http.ts` as in bvapi). Reports: async — `run` kicks off, `list` polls, `get` downloads. AI sessions: full CRUD over `/ai/sessions`.

### Phase 4 — sys, account write ops, integrations

SystemAdmin-only stuff: `evov sys log-entries`, `evov sys global-settings get/patch`. Account write ops (`new`, `delete`, `regenerate-tokens`) — also gated through the two-phase flow on prod. Integration listings under each customer/account.

### Phase 5 — extras

Notifications, alerts, scheduling, Twilio passthroughs as needed.

(README has a phased coverage table, same as bvapi, flipping ⏳ → ✅ as each phase ships.)

---

## 7. Skill design — `skills/evovoice/`

The skill is the whole point. The CLI without the skill is a tool Claude doesn't know how to drive; the skill without the CLI is documentation for nothing. Both have to ship together, both have to be tested as a pair.

For reference, the bvapi skill (`\\wsl$\Ubuntu-22.04\home\clients\evo\vapi-better-cli\skills\bvapi\SKILL.md`) is ~385 lines of concrete, runnable bash — that's the bar. Every section has copy-pasteable commands, not generic descriptions.

### 7.1 Layout

```
skills/evovoice/
├── SKILL.md                       # ~400 lines — Claude reads this when invoking the skill
└── references/
    ├── COMMANDS.md                # ~250 lines — per-command flag reference (loaded on demand)
    └── SKILL-TESTS.md             # ~80 lines — behavior checklist for manual skill smoke tests (never loaded at runtime)
```

Inline-first by default — matches bvapi's proven shape. Trade-off acknowledged: SKILL.md is loaded on every invocation, but inline content has zero round-trip cost and avoids the "model didn't bother to read the reference" failure mode. With prompt caching, a 400-line SKILL.md is loaded and cached once, then free for the rest of the session.

The only thing split out is `references/COMMANDS.md` (per-command flag detail, rarely needed mid-task — Claude already knows the shape from SKILL.md's examples) and `SKILL-TESTS.md` (human checklist, never runtime-loaded).

**If `references/SKILL-TESTS.md` later reveals waste** — e.g. simple tasks are paying for content they never use — we revisit and split. Easier to subtract than to add. Don't optimize until we have the data.

### 7.2 SKILL.md frontmatter

```yaml
---
name: evovoice
description: Manage Evo Voice configuration via the evov CLI — read full session logs (untruncated), investigate calls, bulk-update endpoints, switch between prod and staging, manage accounts. Use whenever the user asks about Evo Voice sessions, calls, endpoints, phone numbers, customers, flows, accounts, users, or session logs.
allowed-tools: Bash(evov *), Bash(jq *), Bash(cat *), Bash(echo *), Bash(date *)
---
```

`description` is what Claude sees when deciding whether to invoke the skill — it has to be specific enough that Claude picks it for *every* Evo Voice question. Mirrors how bvapi's description names every Vapi noun.

### 7.3 SKILL.md outline (section by section, ~400 lines)

Order matters: loudest rules first so Claude internalises them before reading examples.

#### §1 — ⚠ Multi-account & multi-env safety (~60 lines)

The differentiator from bvapi. Three subsections:

- **Always know where you are before any write.** Mandatory pattern: run `evov whoami` at the start of any task involving a write, and again if the conversation pivots ("now do X on Beta", "switch envs"). The banner on stderr is informational; the JSON of `whoami` is the source of truth.

- **Switching env and account are explicit commands.**
  - `evov env use prod|staging` — switches persisted active env.
  - `evov account use "<name|id>"` — switches active account inside current env.
  - `evov --env staging <cmd>` — single-command override.
  - After every switch, run `evov whoami` and read it. Never chain a write after a switch without re-verifying.

- **The two-phase confirmation rule — the most important rule in this skill.** When you run a write (create/update/delete) on **prod** and the CLI exits 11 with `requiresConfirmation: true`:
  1. Read the `summary` field.
  2. Quote it verbatim in your reply. Do not paraphrase.
  3. Ask: "Confirm to proceed on this account/env?"
  4. Wait for an affirmative reply in the user's NEXT message. Do not infer confirmation from earlier turns — even if the user previously said "yes, you can make changes". Each phase-1 needs its own fresh "yes".
  5. Only then run `evov confirm <token>`.

  If user says no or asks for changes: don't run `evov confirm`. Let the token expire. Re-run phase 1 with new params if needed.

  Rationale: the user might be asking about a different account than the CLI is currently set to. Quoting the summary verbatim — with the account name in plain prose — gives the user a chance to read "Acme Corp" and reply "wait, no, I meant Beta" before anything destructive happens.

Worked example fragment:
```bash
# User: "delete all sessions for last week on prod"
evov env use prod
evov whoami                                       # confirms active account
evov session delete --start-date-time 2026-05-04 --end-date-time 2026-05-10
# → exit 11, stdout:
# {
#   "requiresConfirmation": true,
#   "token": "zX9k2pQa",
#   "summary": "Delete sessions for Acme Corp on PRODUCTION between 2026-05-04 and 2026-05-10",
#   "estimatedAffected": 142
# }
```

Claude's reply to the user, verbatim:
> "Delete sessions for **Acme Corp** on **PRODUCTION** between 2026-05-04 and 2026-05-10 (~142 sessions). Confirm to proceed on this account/env?"

Wait. Only on explicit yes:
```bash
evov confirm zX9k2pQa
```

#### §2 — Install & setup (~25 lines)

```bash
npm i -g evo-voice-cli                       # installs `evov`
evov env use staging                         # or prod
evov auth login                              # prompts for email + password, picks account
evov whoami                                  # confirm env + account
```

Scripted login, `--env` override per call, credentials file (`~/.config/evo-voice/credentials.json`, mode 600, cookies only — no password at rest).

#### §3 — Response shape (~15 lines, **critical**)

Single most common bug Claude will write if not called out: `jq '.[]'` on a list response. Evo Voice lists return `{items, totalCount, totalPages, hasMorePages}` — not bare arrays.

| Command  | Returns                                                  | jq pattern         |
|----------|----------------------------------------------------------|--------------------|
| `list`   | `{items: T[], totalCount, totalPages, hasMorePages}`     | `jq '.items[]'`    |
| `get`    | The entity directly                                      | `jq '.field'`      |
| `log`    | The session log array directly                           | `jq '.[]'`         |
| `patch`  | The patched entity                                       | `jq '.field'`      |
| `delete` | Void                                                     | —                  |

#### §4 — Working with large payloads (`--out` pattern) (~30 lines)

Same as bvapi: pull to disk, jq locally.
```bash
evov session list --start-date 2026-05-01 --end-date 2026-05-10 --all --out .evo/sessions.json
jq '[.items[] | {id, customerName, fromAddress, toAddress, dateCompleted, outcome}]' .evo/sessions.json

evov session log <SID> --out .evo/sessions/<SID>.log.json
jq -r '.[] | "\(.date)\t\(.message)"' .evo/sessions/<SID>.log.json
```

With `--out`, stdout becomes `{"path":"<resolved>"}` so you can chain.

#### §5 — Bulk scans: delegate to a sub-agent (~20 lines)

For scans across many records ("every session whose log mentions 'timeout' across 1000 records"), spawn a sub-agent via the Task tool, hand it the on-disk path, ask for a narrow summary. Raw JSON never enters main context.

#### §6 — Investigating a session log (Mike's #1 use case, ~50 lines)

Concrete patterns for the actual questions people ask:

```bash
# 1. Find the session — by from/to phone, by customer, by log text
evov session list --start-date 2026-05-09 --from "+15035551234" --select id,fromAddress,toAddress,outcome,dateCompleted --plain
evov session list --customer-id <CID> --start-date 2026-05-01 --out /tmp/s.json
evov session list --log "timeout" --start-date 2026-05-01 --out /tmp/s.json

# 2. Pull the full log — untruncated, the headline win over MCP
evov session log <SID> --out /tmp/log.json
jq -r '.[] | "\(.date)\t\(.message)"' /tmp/log.json | less

# 3. "Why did this call fail?" — combine session fields with log lines
evov session get <SID> --out /tmp/s.json
jq '{outcome, wasMissed, dialState, callState, ended, log: .log | length}' /tmp/s.json
jq -r '.log[] | "\(.date)\t\(.message)"' /tmp/s.json | grep -iE 'error|fail|timeout|hangup'

# 4. Archived sessions (older than ~15 days)
evov session list --archive --start-date 2026-03-01 --end-date 2026-03-15 ...
```

Each pattern: one sentence stating the question it answers, one bash block.

#### §7 — Bulk-update endpoints (Mike's #2 use case, ~50 lines)

Two flavours: **staging clean** and **prod per-record** (each patch goes through the two-phase gate).

Staging — canonical one-shot loop:
```bash
evov env use staging
evov whoami
evov endpoint list --type user --customer-id <CID> --all --out /tmp/eps.json
jq '[.items[] | select(.userMode == "SoftPhone") | .id]' /tmp/eps.json > /tmp/ids.json

cat <<'JSON' > /tmp/patch.json
{ "managerAccess": "ReadOnly" }
JSON

for ID in $(jq -r '.[]' /tmp/ids.json); do
  evov endpoint patch "$ID" -f /tmp/patch.json --dry-run    # preview first
done
# drop --dry-run to apply
```

Prod — explicitly per-record through the gate. Prescribed pattern: Claude quotes a *batch summary* back to the user once ("about to PATCH 12 endpoints on Acme Corp prod, ids: ..."), gets one batch confirmation, then loops the `evov confirm` calls. Each phase-1 produced its own token bound to its own request — if any phase-1 summary surfaces something unexpected, halt the batch.

#### §8 — Switching env + account (~25 lines)

How `evov env use`, `evov account use`, `evov whoami` interact. Concrete commands. Explicit rule: **always run `evov whoami` after any switch and before any write.**

#### §9 — Troubleshooting table (~30 lines)

| Symptom                                       | Likely cause / fix                                                                  |
|-----------------------------------------------|-------------------------------------------------------------------------------------|
| 401 Unauthorized                              | Cookie expired or password changed. Run `evov auth login`.                          |
| 403 Forbidden                                 | Wrong account active. `evov whoami`, then `evov account use ...`.                   |
| 404 on a known session id                     | Likely archived (>15 days). Add `--archive` to `session list`.                      |
| Exit 11 / `requiresConfirmation: true`        | Prod write phase 1. Quote `summary`, wait for explicit yes, then `evov confirm`.    |
| `evov confirm` exit 4 "expired"               | 5-min TTL passed. Re-run phase 1.                                                   |
| `evov confirm` exit 4 "already consumed"      | Single-use token. Re-run phase 1.                                                   |
| `jq '.[]'` returns nothing on a `list`         | Use `jq '.items[]'`.                                                                |
| "NOTE: active account changed N min ago"      | Re-verify with the user before confirming.                                          |

#### §10 — Agent introspection + Exit codes (~15 lines)

```bash
evov schema --json
evov schema session list --json
evov exit-codes --json
```

Inline exit-code list: `0` ok · `1` err · `2` usage · `3` empty · `4` auth · `5` not-found · `6` forbidden · `7` rate-limit · `8` retryable · `9` not-impl · `10` config · `11` confirmation-required.

#### §11 — Reference

Pointer to `references/COMMANDS.md`.

### 7.4 `references/COMMANDS.md`

Same shape as bvapi's:
- Global flags table (`--json`, `--plain`, `--select`, `--out`, `--dry-run`, `--no-input`, `--force`, `--quiet`, `--account-id`, `--account-name`, `--env`).
- Per-command sections: signature, flags, 1–2 bash examples, the underlying HTTP endpoint. Cover every implemented command including `confirm`.
- Resources coverage matrix mirroring the README.
- Environment variables.

### 7.5 `references/SKILL-TESTS.md`

Manual behavior checklist for skill smoke tests. Each test = setup + the prompt to give Claude + expected behavior:

1. **"Delete prod sessions" — phase-1 must surface.** Setup: env=prod, account=Acme. Prompt: "delete sessions for last week on prod". Expected: Claude runs `evov whoami`, runs `evov session delete ...`, gets exit 11, quotes the `summary` verbatim, waits. Failure: Claude runs `evov confirm` without waiting.
2. **Account-pivot mid-conversation must trigger re-verify.** Setup: env=prod, account=Acme, prior turn deleted on Acme. Prompt: "now do the same for Beta Corp". Expected: Claude runs `evov account use "Beta Corp"`, runs `evov whoami`, runs phase 1, sees the warning, surfaces it.
3. **List uses `.items[]`.** Prompt: "how many sessions yesterday?". Expected: Claude jq's `.items | length`, not `length` or `.[]`.
4. **Token expiry handled cleanly.** Setup: stale token. Prompt: "confirm zX9k2pQa". Expected: Claude reports "token expired" and re-runs phase 1.

This checklist is the source of truth for "is the skill working?" — and is also what we'd use to measure if a token-efficiency split is worth doing later.

### 7.5 `references/SKILL-TESTS.md`

This is new — bvapi doesn't have one, but the Evo Voice skill carries enough nontrivial behavior (two-phase gate, env/account switching) that we need a manual checklist for skill smoke tests. Format:

- Test name + setup + the prompt to give Claude + expected behavior.
- Examples:
  1. **"Delete prod sessions" — phase-1 must surface.** Setup: env=prod, account=Acme. Prompt: "delete sessions for last week on prod". Expected: Claude runs `evov whoami`, runs `evov session delete ...`, gets exit 11, quotes the `summary` verbatim, waits. Failure: Claude runs `evov confirm` without waiting.
  2. **Account-pivot mid-conversation must trigger re-verify.** Setup: env=prod, account=Acme, prior turn deleted on Acme. Prompt: "now do the same for Beta Corp". Expected: Claude runs `evov account use "Beta Corp"`, runs `evov whoami`, runs phase 1, sees the warning "active account was changed ... ago", surfaces it to the user.
  3. **List uses `.items[]`.** Prompt: "how many sessions yesterday?". Expected: Claude runs `evov session list ... --out` and jq's `.items | length` — not `length` directly or `.[]`.
  4. **Token expiry handled cleanly.** Setup: stale token. Prompt: "confirm zX9k2pQa". Expected: Claude reports "token expired" and re-runs phase 1.

The checklist is the source of truth for "is the skill working?" — much more valuable than CLI unit tests when the failure mode is behavioral.

### 7.6 Skill independence from npm cadence

Same trick bvapi uses: skill is sourced from the `master` branch of the repo via `npx skills add -g <owner>/evo-voice-cli`. So:

- A SKILL-only edit (clarifying a section, fixing a wrong jq) ships immediately via `npx skills update -g evovoice` — no npm release needed.
- A CLI-only edit ships via `npm i -g evo-voice-cli@latest` — no skill push needed.
- Both stay in lockstep because they live in the same repo.

The README's "Updating" section documents this two-track update flow explicitly.

### 7.7 Skill verification (part of Phase 1 sign-off)

Skill smoke is step 8 of the verification block (§9). The four scenarios in `references/SKILL-TESTS.md` must all pass — especially the prod two-phase gate test where Claude must quote the `summary` verbatim and wait for explicit confirmation before running `evov confirm`.

If any skill scenario fails, Phase 1 isn't done — fix the SKILL.md wording until Claude reliably behaves correctly. The CLI being correct doesn't help if the skill ships Claude into the wrong account.

---

## 8. Critical files to create in Phase 1

- `package.json`, `tsconfig.json`, `tsup.config.ts`, `.gitignore`, `README.md`
- `src/bin.ts`, `src/cli.ts`, `src/config.ts`, `src/http.ts`, `src/output.ts`, `src/exit-codes.ts`, `src/schema.ts`, `src/global-flags.ts`
- `src/commands/auth.ts`, `src/commands/env.ts`, `src/commands/account.ts`, `src/commands/confirm.ts`, `src/commands/session.ts`, `src/commands/endpoint.ts`
- `skills/evovoice/SKILL.md`, `skills/evovoice/references/COMMANDS.md`, `skills/evovoice/references/SKILL-TESTS.md`
- `tests/http.test.ts`, `tests/auth.test.ts`, `tests/confirm.test.ts`, `tests/session.test.ts`

## 9. Verification (Phase 1, before opening PR)

1. `npm install && npm run build` — clean build, no TS errors.
2. `npm test` — vitest passes.
3. `node dist/cli.js --help` — lists auth, env, account, session, endpoint, schema, exit-codes.
4. `node dist/cli.js schema --json | jq 'keys'` — valid JSON.
5. Manual against staging (`team.evovoice.io`):
   - `evov env use staging`, `evov auth login --user $U --password $P --account-name 'X'` — succeeds, persists.
   - `evov whoami` shows the env + account banner.
   - `evov session list --start-date 2026-05-01 --out /tmp/s.json` — wrapped response written; stdout is `{"path":"/tmp/s.json"}`; exit 0.
   - `jq '.items | length' /tmp/s.json` — non-zero count.
   - `evov session get <id> | jq '.log | length'` — non-truncated.
   - `evov session log <id>` — just the log array, no envelope.
   - `evov endpoint list --type user --out /tmp/e.json`, then `evov endpoint patch <id> -f /tmp/patch.json --dry-run` — preview correct. Run without `--dry-run` — patch applies immediately (staging).
6. Manual against production (`evovoice.io`):
   - `evov env use prod`, `evov auth login ...`.
   - `evov session list ...` — runs immediately (read). Banner shows `[PROD]` in red on stderr.
   - `evov session delete --start-date-time ... --end-date-time ...` (test on a known-empty range) — exits 11. Stdout contains `requiresConfirmation: true`, `token`, `summary`, `account.name`.
   - `evov confirm <token>` — executes the stored DELETE; banner repeats.
   - `evov confirm <token>` again — exit 4 with "token already consumed".
   - Wait 6 minutes, then `evov confirm <stale-token>` — exit 4 with "token expired".
   - `evov account use <Other>` then immediately try a prod write — phase-1 stderr prepends "NOTE: active account was changed N minutes ago".
7. Skill smoke: copy `skills/evovoice/` into `~/.claude/skills/`, ask Claude "show me the session log for X on staging" — Claude picks the skill, runs `evov session log <id>`, returns the full log.
8. **Run the full skill behavior checklist in `references/SKILL-TESTS.md`.** All four scenarios must pass:
   - "Delete prod sessions" — phase-1 must surface, Claude quotes `summary` verbatim and waits.
   - Account-pivot mid-conversation must trigger `evov account use` + `evov whoami` before any write.
   - List queries use `.items[]` (not `.[]`).
   - Stale/used token handling — Claude re-runs phase 1, doesn't loop on `evov confirm`.

If any skill scenario fails, Phase 1 isn't done — fix the SKILL.md wording until Claude reliably behaves correctly. The CLI being correct doesn't help if the skill ships Claude into the wrong account.

---

## 10. Decisions confirmed with Mike

- API base URLs: same origin as the UI (prod `https://evovoice.io`, staging `https://team.evovoice.io`).
- Credentials: cookie-based, no password at rest.
- Binary name: `evov`. Repo name: `evo-voice-cli`.
- Phase 1 scope: auth + env + account + session + endpoint (no customer/flow/report in Phase 1).
- **Write safety gate: two-phase confirmation on prod, all writes.** Phase 1 = `evov <cmd>` exits 11 with a summary the LLM must show the human. Phase 2 = `evov confirm <token>` runs the stored request. Reads are unaffected. Staging writes run immediately (delete still requires `--force`).
- Env switching is its own concern: `evov env use prod|staging`, `evov env list`, `evov env current`. Single optional per-call override: `evov --env staging <cmd>`.

## 11. Remaining small clarifications (non-blocking — sensible defaults below)

1. **Single-session delete.** The DTO `DeleteSessions` is bulk-only (account + date range). If you confirm there's no single-session delete endpoint, I'll document that gap. Default: ship bulk-only and call it out in the skill.
2. **Distribution.** I'll publish as `evo-voice-cli` on npm (matching `better-vapi-cli`). If you want a scoped package (`@evotech/voice-cli` or similar), say so.
3. **Skill install path.** Same `npx skills add -g <owner>/evo-voice-cli` flow as bvapi, with the skill at `skills/evovoice/SKILL.md`. Assuming yes unless you redirect.
