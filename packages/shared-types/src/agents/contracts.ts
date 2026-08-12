/**
 * Structured contracts for the M3 agent pipeline (Master → Research →
 * Reviewer → Master). Each is the `data` payload of a `DataPart` on the
 * corresponding task's output/messages — not free-form text, so Reviewer
 * can validate shape mechanically before it even reads content.
 */

export type EvidenceKind = "fact" | "assumption" | "uncertain";

export interface ResearchFinding {
  claim: string;
  kind: EvidenceKind;
  /** null when the claim comes from the model's own training knowledge, not a connected tool. */
  source: string | null;
}

export interface ResearchResult {
  objective: string;
  findings: ResearchFinding[];
  /** Explicit, honest capability gaps — e.g. "web_search_unavailable" when no MCP tool is connected (M3: always, until M4). Never silently omitted. */
  limitations: string[];
  /** False in M3 — no MCP tool host exists yet, so nothing here was independently verified. */
  toolsUsed: string[];
}

export type ReviewDecision = "APPROVE" | "REVISE" | "REJECT";

export type ReviewIssueType =
  | "incomplete"
  | "schema_invalid"
  | "contradiction"
  | "unsupported_claim"
  | "missing_evidence"
  | "hallucination_risk";

export interface ReviewIssue {
  type: ReviewIssueType;
  description: string;
}

export interface ReviewResult {
  decision: ReviewDecision;
  issues: ReviewIssue[];
  /** Short, user-safe summary — never raw chain-of-thought. */
  summary: string;
}

/** Master's per-message intent classification — never shown to the user directly, only its safe consequences (delegation events). */
export interface IntentClassification {
  delegate: boolean;
  /** Required capability tag (matches an AgentCard.capabilities entry) when delegate is true. */
  capability: string | null;
  /** A short, self-contained restatement of what the delegated agent should accomplish. */
  taskObjective: string | null;
  memoryCommand: { action: "remember" | "forget"; content?: string } | null;
  /** Optional system-proposed memory candidate — stored as `approval_status: 'pending'`, never auto-approved. */
  memoryCandidate: { category: string; content: string; confidence: number } | null;
}
