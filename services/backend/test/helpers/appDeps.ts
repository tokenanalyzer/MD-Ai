import type pg from "pg";
import { AgentRegistryService } from "../../src/core/agents/agentRegistryService.js";
import { MemoryEngineService } from "../../src/core/memory/memoryEngine.js";
import { ToolRegistryService } from "../../src/core/mcp/toolRegistryService.js";
import { createResearchAgent } from "../../src/core/agents/research/researchAgent.js";
import { createReviewerAgent } from "../../src/core/agents/reviewer/reviewerAgent.js";
import { createMasterAgent } from "../../src/core/agents/master/masterAgent.js";
import { webSearchTool } from "../../src/core/mcp/tools/webSearchTool.js";
import { urlReaderTool } from "../../src/core/mcp/tools/urlReaderTool.js";
import { fileReaderTool } from "../../src/core/mcp/tools/fileReaderTool.js";
import { pdfReaderTool } from "../../src/core/mcp/tools/pdfReaderTool.js";
import { calculatorTool } from "../../src/core/mcp/tools/calculatorTool.js";
import { timeDateTool } from "../../src/core/mcp/tools/timeDateTool.js";
import { httpGetTool } from "../../src/core/mcp/tools/httpGetTool.js";

/** Mirrors src/index.ts's boot-time agent/tool registration, for tests that need a real `createApp` deps object. */
export function buildTestAgentRegistry(pool: pg.Pool): {
  agentRegistry: AgentRegistryService;
  memoryEngine: MemoryEngineService;
  toolRegistry: ToolRegistryService;
} {
  const agentRegistry = new AgentRegistryService(pool);
  const memoryEngine = new MemoryEngineService(pool);
  const toolRegistry = new ToolRegistryService(pool);
  agentRegistry.register(createResearchAgent());
  agentRegistry.register(createReviewerAgent());
  agentRegistry.register(createMasterAgent({ agentRegistry, memoryEngine }));
  toolRegistry.register(webSearchTool);
  toolRegistry.register(urlReaderTool);
  toolRegistry.register(fileReaderTool);
  toolRegistry.register(pdfReaderTool);
  toolRegistry.register(calculatorTool);
  toolRegistry.register(timeDateTool);
  toolRegistry.register(httpGetTool);
  return { agentRegistry, memoryEngine, toolRegistry };
}
