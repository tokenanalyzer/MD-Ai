import type { Agent } from "@mdai/shared-types";
import { createSpecialistAgent, type SpecialistAgentConfig } from "./specialistAgentFactory.js";

/**
 * M8 roster (docs/architecture/04-agent-interfaces.md §2 /
 * 09-roadmap.md M8). Each `id`/`capabilities` entry must match the
 * `agents`/`agent_delegation_edges` rows seeded by migration
 * `0021_m8_specialists_guardian.sql` exactly, or the agent exists in the
 * registry but Master can never select it.
 */
const SPECIALIST_CONFIGS: SpecialistAgentConfig[] = [
  {
    id: "crypto-intel",
    displayName: "Crypto Intel",
    description:
      "Crypto market and on-chain-context research using web search and page reading when available, honestly disclosing the lack of a live price/order-book/on-chain feed.",
    domainFocus: "crypto markets and on-chain context",
    capabilities: ["crypto-analysis"],
  },
  {
    id: "stock-intel",
    displayName: "Stock Intel",
    description:
      "Equities/market research using web search and page reading when available, honestly disclosing the lack of a live market-data feed.",
    domainFocus: "equities and stock market analysis",
    capabilities: ["stock-analysis"],
  },
  {
    id: "business-intel",
    displayName: "Business Intel",
    description: "Company/business-opportunity research using web search and page reading when available.",
    domainFocus: "company and business-opportunity research",
    capabilities: ["business-research"],
  },
  {
    id: "social-media",
    displayName: "Social Media Intel",
    description:
      "Social trend/sentiment research using web search and page reading when available, honestly disclosing the lack of a connected social-platform API.",
    domainFocus: "social trends and sentiment analysis",
    capabilities: ["social-analysis"],
  },
  {
    id: "ai-radar",
    displayName: "AI Radar",
    description: "Tracks the AI model/tooling landscape using web search and page reading when available.",
    domainFocus: "the AI model and tooling landscape",
    capabilities: ["ai-landscape-tracking"],
  },
  {
    id: "news-intel",
    displayName: "News Intel",
    description: "News synthesis and relevance filtering using web search and page reading when available.",
    domainFocus: "news synthesis and relevance filtering",
    capabilities: ["news-synthesis"],
  },
];

export function createSpecialistAgents(): Agent[] {
  return SPECIALIST_CONFIGS.map(createSpecialistAgent);
}
