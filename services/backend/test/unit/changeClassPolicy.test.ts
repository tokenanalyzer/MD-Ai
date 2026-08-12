import { describe, expect, it } from "vitest";
import { computeRequiresApproval } from "../../src/core/evolution/changeClassPolicy.js";

describe("Evolution change-class policy (M9) — docs/architecture/07-security-model.md §5", () => {
  it("application_code_update always requires approval — no exception, regardless of any option passed", () => {
    expect(computeRequiresApproval("application_code_update")).toBe(true);
    expect(computeRequiresApproval("application_code_update", { touchesRestrictedToolOrGrant: false })).toBe(true);
    expect(computeRequiresApproval("application_code_update", { touchesRestrictedToolOrGrant: true })).toBe(true);
  });

  it("skill_update requires approval only when it touches a restricted tool/grant", () => {
    expect(computeRequiresApproval("skill_update")).toBe(false);
    expect(computeRequiresApproval("skill_update", { touchesRestrictedToolOrGrant: false })).toBe(false);
    expect(computeRequiresApproval("skill_update", { touchesRestrictedToolOrGrant: true })).toBe(true);
  });

  it("knowledge_update, model_registry_update, and routing_policy_update always auto-apply (never require approval)", () => {
    expect(computeRequiresApproval("knowledge_update")).toBe(false);
    expect(computeRequiresApproval("model_registry_update")).toBe(false);
    expect(computeRequiresApproval("routing_policy_update")).toBe(false);
  });
});
