import type { AgentRuntimeContext, ChatMessage, IntentClassification, MemoryCategory } from "@mdai/shared-types";
import { extractJson } from "../structuredOutput.js";

const MEMORY_CATEGORIES: MemoryCategory[] = [
  "personal_context",
  "projects",
  "goals",
  "preferences",
  "decisions",
  "research",
  "knowledge",
  "conversations",
  "agent_lessons",
];

function systemPrompt(capabilities: string[]): string {
  const capabilityList = capabilities.length > 0 ? capabilities.join(", ") : "(none currently available)";
  return `You are the intent classifier inside MD AI's Master Agent. You do not answer the user — you only produce a small JSON control object that Master uses to decide what to do next. Never include chain-of-thought or explanation, only the JSON object below.

Respond with ONLY a JSON object of this exact shape:
{
  "delegate": true | false,
  "capability": "<one of: ${capabilityList}>" | null,
  "taskObjective": "<short, self-contained restatement of what the delegated agent should accomplish>" | null,
  "memoryCommand": { "action": "remember" | "forget", "content": "<the specific fact/preference to remember or forget>" } | null,
  "memoryCandidate": { "category": "<one of: ${MEMORY_CATEGORIES.join(", ")}>", "content": "<durable fact worth remembering>", "confidence": <0-1> } | null
}

Rules:
- "delegate": true only if the user's request genuinely needs a specialist capability from the list above (e.g. dedicated research/investigation). For an ordinary question you can answer yourself from general knowledge, set delegate=false and capability=null. Never invent a capability that isn't in the list.
- "memoryCommand" is set ONLY when the user gives an explicit, direct instruction to remember or forget something (e.g. "Remember this: ...", "Forget that I said ..."). Otherwise it is null. Never infer a memory command from an ordinary statement.
- "memoryCandidate" is an optional, conservative proposal for something durable worth storing (a stated preference, an ongoing project, a firm decision) that the user shared but did NOT explicitly ask to be remembered. Set it to null for almost every message — only propose a candidate for something clearly durable and specific, never for casual chat, and never for anything sensitive (health, financial, or otherwise private details) without the user's explicit consent already given elsewhere in the conversation. When in doubt, use null.
- Output ONLY the JSON object, no prose before or after.`;
}

function recentContext(messages: ChatMessage[], maxTurns = 6): string {
  const nonSystem = messages.filter((m) => m.role !== "system");
  const recent = nonSystem.slice(-1 - maxTurns, -1);
  if (recent.length === 0) return "";
  return `\n\nRecent conversation context (for disambiguating references like "that" or "forget it"):\n${recent
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n")}`;
}

/**
 * Master's single classification step (M3.2/M3.6). Capabilities are always
 * the caller-supplied, dynamically-discovered list from the Agent
 * Registry (`agentRegistry.getDelegationOptions('master')`) — never
 * hardcoded here, so a newly registered specialist agent becomes
 * selectable without touching this file.
 */
export async function classifyIntent(
  ctx: AgentRuntimeContext,
  userText: string,
  conversationMessages: ChatMessage[],
  availableCapabilities: string[],
): Promise<IntentClassification> {
  const fallback: IntentClassification = {
    delegate: false,
    capability: null,
    taskObjective: null,
    memoryCommand: null,
    memoryCandidate: null,
  };

  const { text } = await ctx.completeChat({
    taskCategory: "fast",
    messages: [
      { role: "system", content: systemPrompt(availableCapabilities) },
      { role: "user", content: `${userText}${recentContext(conversationMessages)}` },
    ],
  });

  const parsed = extractJson<IntentClassification>(text);
  if (!parsed) return fallback;

  const capability =
    typeof parsed.capability === "string" && availableCapabilities.includes(parsed.capability) ? parsed.capability : null;

  const memoryCommand =
    parsed.memoryCommand &&
    (parsed.memoryCommand.action === "remember" || parsed.memoryCommand.action === "forget") &&
    typeof parsed.memoryCommand.content === "string" &&
    parsed.memoryCommand.content.trim()
      ? { action: parsed.memoryCommand.action, content: parsed.memoryCommand.content.trim() }
      : null;

  const memoryCandidate =
    parsed.memoryCandidate &&
    MEMORY_CATEGORIES.includes(parsed.memoryCandidate.category as MemoryCategory) &&
    typeof parsed.memoryCandidate.content === "string" &&
    parsed.memoryCandidate.content.trim()
      ? {
          category: parsed.memoryCandidate.category,
          content: parsed.memoryCandidate.content.trim(),
          confidence: typeof parsed.memoryCandidate.confidence === "number" ? parsed.memoryCandidate.confidence : 0.5,
        }
      : null;

  return {
    delegate: Boolean(parsed.delegate) && capability !== null,
    capability,
    taskObjective: typeof parsed.taskObjective === "string" && parsed.taskObjective.trim() ? parsed.taskObjective.trim() : null,
    memoryCommand,
    memoryCandidate,
  };
}
