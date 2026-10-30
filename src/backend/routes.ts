import type { Request, Response, Router } from "express";
import {
  type RunDeps,
  type RunOutcome,
  runOnHost,
  validateRunInput,
} from "./run-api.js";

export function registerRoutes(router: Router, deps: RunDeps): void {
  router.use(deps.ctx.rbac.require("run") as never);

  /**
   * @openapi
   * /plugin-api/winrm/run:
   *   post:
   *     summary: Run a PowerShell script on a host over WinRM
   *     description: >
   *       Opens a PowerShell session on a saved host with WinRM turned on, runs the script,
   *       deletes the session and returns what it produced. Uses the host's saved WinRM login
   *       and jump hosts. The script is not written to the audit log, only its sha256.
   *     tags:
   *       - WinRM
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [hostId, script]
   *             properties:
   *               hostId:
   *                 type: integer
   *               script:
   *                 type: string
   *                 description: PowerShell, up to 256 KB.
   *               timeoutSec:
   *                 type: integer
   *                 minimum: 1
   *                 maximum: 600
   *                 default: 60
   *               width:
   *                 type: integer
   *                 minimum: 40
   *                 maximum: 500
   *                 default: 160
   *                 description: Width PowerShell formats tables at.
   *     responses:
   *       200:
   *         description: >
   *           The script ran. state is completed, failed (a terminating error), stopped or
   *           timeout. output is the formatted output, errors, warnings, verbose and
   *           information hold the other streams, truncated says output was cut at 1 MB.
   *       400:
   *         description: Invalid input, or WinRM is not set up on the host.
   *       403:
   *         description: Missing the winrm.run permission.
   *       404:
   *         description: Host not found or no access.
   *       429:
   *         description: Too many WinRM sessions open.
   *       502:
   *         description: The host could not be reached or refused the login. kind tells which.
   */
  router.post("/run", async (req: Request, res: Response) => {
    const checked = validateRunInput(req.body);
    if ("error" in checked) {
      res.status(400).json({ error: checked.error, kind: "input" });
      return;
    }
    // runOnHost never throws for a remote problem, so a broken host can't
    // spend the plugin's error budget.
    const outcome: RunOutcome = await runOnHost(deps, checked.input).catch(
      (error: unknown) => {
        deps.ctx.log.error(
          "WinRM run route failed",
          error instanceof Error ? error : new Error(String(error)),
        );
        return {
          ok: false as const,
          status: 500,
          error: "The run failed unexpectedly",
          kind: "internal",
        };
      },
    );
    if ("result" in outcome) res.json(outcome.result);
    else
      res
        .status(outcome.status)
        .json({ error: outcome.error, kind: outcome.kind });
  });
}
