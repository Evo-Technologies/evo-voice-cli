import { Command } from "commander";

import {
  consumePending,
  getPending,
  loadConfig,
  requireAuthenticated,
  resolveActiveEnv,
  type EnvName,
} from "../config.js";
import { addGlobalFlags } from "../global-flags.js";
import { selectJsonFields } from "../fingerprint.js";
import { ssFetch } from "../http.js";
import { emit, note, printBanner, type GlobalFlags } from "../output.js";
import { enforcePendingTenantGuard } from "../tenant-guard.js";
import { assertRequestState } from "../write-gate.js";

export function buildConfirmCommand(): Command {
  return addGlobalFlags(new Command("confirm"))
    .argument("<token>", "Token from a prior phase-1 response (exit 11)")
    .description("Execute a stored phase-1 write request (production two-phase confirmation)")
    .action(async (token: string, _opts, command: Command) => {
      const globals = command.optsWithGlobals<GlobalFlags>();
      const pending = getPending(token);
      enforcePendingTenantGuard(pending.env, pending.accountId, globals);

      // Use the env the pending action was created against — not the current active env.
      const cfg = loadConfig();
      const env = resolveActiveEnv(cfg, pending.env as EnvName);
      const prof = requireAuthenticated(env);
      printBanner(env, globals, prof.user);

      note(`Executing ${pending.action} — ${pending.summary}`, globals);

      // Mark consumed BEFORE issuing the request so a network hang can't be retried into a double-spend.
      consumePending(token);

      if (pending.precondition) {
        await assertRequestState(pending.baseUrl, prof.cookies, pending.precondition, "precondition");
      }

      const res = await ssFetch(pending.method, pending.path, {
        baseUrl: pending.baseUrl,
        cookies: prof.cookies,
        query: pending.query as Record<string, string | number | boolean | string[] | undefined> | undefined,
        body: pending.body,
      });

      if (pending.verification) {
        await assertRequestState(pending.baseUrl, prof.cookies, pending.verification, "verification");
      }

      const projected = pending.responseFields ? selectJsonFields(res.data, pending.responseFields) : res.data;
      emit(projected ?? { ok: true, verified: !!pending.verification }, globals);
    });
}
