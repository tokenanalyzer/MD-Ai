import pino from "pino";
import type pg from "pg";
import type { Redis } from "ioredis";
import type { NotificationSender } from "@mdai/shared-types";
import { EventBus } from "../../src/core/events/eventBus.js";
import { AgentRegistryService } from "../../src/core/agents/agentRegistryService.js";
import { MemoryEngineService } from "../../src/core/memory/memoryEngine.js";
import { ModelRegistryService } from "../../src/core/registry/modelRegistryService.js";
import { ToolRegistryService } from "../../src/core/mcp/toolRegistryService.js";
import { createResearchAgent } from "../../src/core/agents/research/researchAgent.js";
import { createReviewerAgent } from "../../src/core/agents/reviewer/reviewerAgent.js";
import { createMasterAgent } from "../../src/core/agents/master/masterAgent.js";
import { createSpecialistAgents } from "../../src/core/agents/specialist/specialists.js";
import { createGuardianAgent } from "../../src/core/agents/guardian/guardianAgent.js";
import { webSearchTool } from "../../src/core/mcp/tools/webSearchTool.js";
import { urlReaderTool } from "../../src/core/mcp/tools/urlReaderTool.js";
import { fileReaderTool } from "../../src/core/mcp/tools/fileReaderTool.js";
import { pdfReaderTool } from "../../src/core/mcp/tools/pdfReaderTool.js";
import { calculatorTool } from "../../src/core/mcp/tools/calculatorTool.js";
import { timeDateTool } from "../../src/core/mcp/tools/timeDateTool.js";
import { httpGetTool } from "../../src/core/mcp/tools/httpGetTool.js";
import { BotRegistryService } from "../../src/core/bots/botRegistryService.js";
import { BotEngine } from "../../src/core/bots/botEngine.js";
import { aiModelReleaseMonitor } from "../../src/core/bots/aiModelReleaseMonitor.js";
import { newsMonitor } from "../../src/core/bots/newsMonitor.js";
import { createUserTopicMonitor } from "../../src/core/bots/userTopicMonitor.js";
import { createSystemHealthMonitor } from "../../src/core/bots/systemHealthMonitor.js";
import { marketScanner } from "../../src/core/bots/marketScanner.js";
import { liquidityMonitor } from "../../src/core/bots/liquidityMonitor.js";
import { volumeAnomalyMonitor } from "../../src/core/bots/volumeAnomalyMonitor.js";
import { socialTrendMonitor } from "../../src/core/bots/socialTrendMonitor.js";
import { businessOpportunityMonitor } from "../../src/core/bots/businessOpportunityMonitor.js";
import { AutomationEngine } from "../../src/core/automations/automationEngine.js";

const noopNotificationSender: NotificationSender = {
  async send() {
    return { delivered: [], failed: [] };
  },
};

const logger = pino({ level: "silent" });

/** Mirrors src/index.ts's boot-time agent/tool/bot registration, for tests that need a real `createApp` deps object. The returned `BotEngine`/`AutomationEngine` are NOT started (`.start()` is never called) — most tests never touch bots/automations and starting either would schedule real BullMQ repeatable jobs against the shared test Redis instance; bot/automation-specific tests call `.start()`/`.runNow()` themselves. */
export function buildTestAgentRegistry(
  pool: pg.Pool,
  redis?: Redis,
): {
  agentRegistry: AgentRegistryService;
  memoryEngine: MemoryEngineService;
  toolRegistry: ToolRegistryService;
  botRegistry: BotRegistryService;
  botEngine: BotEngine;
  automationEngine: AutomationEngine;
} {
  const agentRegistry = new AgentRegistryService(pool);
  const memoryEngine = new MemoryEngineService(pool);
  const toolRegistry = new ToolRegistryService(pool);
  agentRegistry.register(createResearchAgent());
  agentRegistry.register(createReviewerAgent());
  agentRegistry.register(createMasterAgent({ agentRegistry, memoryEngine }));
  for (const specialist of createSpecialistAgents()) {
    agentRegistry.register(specialist);
  }
  agentRegistry.register(createGuardianAgent());
  toolRegistry.register(webSearchTool);
  toolRegistry.register(urlReaderTool);
  toolRegistry.register(fileReaderTool);
  toolRegistry.register(pdfReaderTool);
  toolRegistry.register(calculatorTool);
  toolRegistry.register(timeDateTool);
  toolRegistry.register(httpGetTool);

  const botRegistry = new BotRegistryService(pool);
  botRegistry.register(aiModelReleaseMonitor);
  botRegistry.register(newsMonitor);
  botRegistry.register(createUserTopicMonitor(pool));
  if (redis) botRegistry.register(createSystemHealthMonitor(pool, redis));
  botRegistry.register(marketScanner);
  botRegistry.register(liquidityMonitor);
  botRegistry.register(volumeAnomalyMonitor);
  botRegistry.register(socialTrendMonitor);
  botRegistry.register(businessOpportunityMonitor);
  const botEngine = new BotEngine({
    pool,
    eventBus: new EventBus(pool),
    botRegistry,
    modelRegistry: new ModelRegistryService(pool),
    agentRegistry,
    toolRegistry,
    ownerId: "",
    notificationSender: noopNotificationSender,
  });

  const automationEngine = new AutomationEngine({
    pool,
    eventBus: new EventBus(pool),
    modelRegistry: new ModelRegistryService(pool),
    agentRegistry,
    toolRegistry,
    ownerId: "",
    notificationSender: noopNotificationSender,
    logger,
  });

  return { agentRegistry, memoryEngine, toolRegistry, botRegistry, botEngine, automationEngine };
}
