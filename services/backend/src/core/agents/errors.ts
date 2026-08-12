export class DelegationNotAuthorizedError extends Error {
  constructor(
    readonly fromAgentId: string,
    readonly toAgentId: string,
  ) {
    super(`${fromAgentId} is not authorized to delegate to ${toAgentId} (no agent_delegation_edges row)`);
    this.name = "DelegationNotAuthorizedError";
  }
}

export class AgentUnavailableError extends Error {
  constructor(readonly agentId: string) {
    super(`Agent "${agentId}" has no running implementation registered in this process`);
    this.name = "AgentUnavailableError";
  }
}

/**
 * Thrown by `streamChat` when the root task was canceled mid-stream.
 * Best-effort only (the M1 cancellation limitation carried forward to
 * M3 — docs/architecture/03-api-contracts.md §2): stops forwarding
 * further chunks to the client, but does not abort the in-flight
 * provider HTTP request itself.
 */
export class TaskCanceledError extends Error {
  constructor(readonly taskId: string) {
    super(`Task ${taskId} was canceled`);
    this.name = "TaskCanceledError";
  }
}
