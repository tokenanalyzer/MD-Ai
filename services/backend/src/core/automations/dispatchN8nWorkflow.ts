import type { AutomationRow } from "../../db/repositories/automationRepo.js";
import { safeFetch } from "../security/ssrfGuard.js";

export interface DispatchN8nWorkflowResult {
  status: number;
  responseSnippet: string;
}

/**
 * M10 `action_type = 'n8n_workflow'`: a single outbound POST to the
 * n8n webhook URL the owner configured in `action_config.webhookUrl` —
 * MD AI never runs n8n's workflow logic itself (`infra/n8n/README.md`:
 * "Neither system depends on the other being present"). Still goes
 * through `safeFetch`'s full HTTPS-only/private-IP/DNS-rebinding
 * validation (M4/M5's SSRF protections apply to this call exactly like
 * any other outbound fetch — an owner-configured URL is trusted to be
 * the *right* endpoint, not exempted from being a *safe* one) with a
 * fixed, bounded timeout.
 */
export async function dispatchN8nWorkflow(
  automation: AutomationRow,
  automationRunId: string,
  signal: AbortSignal,
): Promise<DispatchN8nWorkflowResult> {
  const webhookUrl = automation.action_config["webhookUrl"];
  if (typeof webhookUrl !== "string" || !webhookUrl) {
    throw new Error(`Automation ${automation.id} has no action_config.webhookUrl configured`);
  }

  const body = JSON.stringify({
    automationId: automation.id,
    automationRunId,
    automationName: automation.name,
    triggeredAt: new Date().toISOString(),
  });

  const result = await safeFetch(webhookUrl, {
    signal,
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
    maxBytes: 100_000,
  });

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`n8n webhook returned HTTP ${result.status}: ${result.body.slice(0, 300)}`);
  }

  return { status: result.status, responseSnippet: result.body.slice(0, 2000) };
}
