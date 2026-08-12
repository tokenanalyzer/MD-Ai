import type pg from "pg";
import { AgentRegistryService } from "../../src/core/agents/agentRegistryService.js";
import { MemoryEngineService } from "../../src/core/memory/memoryEngine.js";
import { createResearchAgent } from "../../src/core/agents/research/researchAgent.js";
import { createReviewerAgent } from "../../src/core/agents/reviewer/reviewerAgent.js";
import { createMasterAgent } from "../../src/core/agents/master/masterAgent.js";

/** Mirrors src/index.ts's boot-time agent registration, for tests that need a real `createApp` deps object. */
export function buildTestAgentRegistry(pool: pg.Pool): {
  agentRegistry: AgentRegistryService;
  memoryEngine: MemoryEngineService;
} {
  const agentRegistry = new AgentRegistryService(pool);
  const memoryEngine = new MemoryEngineService(pool);
  agentRegistry.register(createResearchAgent());
  agentRegistry.register(createReviewerAgent());
  agentRegistry.register(createMasterAgent({ agentRegistry, memoryEngine }));
  return { agentRegistry, memoryEngine };
}
