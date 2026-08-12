import type pg from "pg";
import type { BotDefinition, BotRunContext, BotRunResult, NormalizedFinding } from "@mdai/shared-types";
import { listDueUserTopics, touchUserTopicChecked } from "../../db/repositories/userTopicRepo.js";
import { meetsImportanceThreshold } from "./dedup.js";

/**
 * M5.10: user-defined topics (frequency + importance threshold, stored as
 * `user_topics` config — see the mobile Topics screen) rather than a
 * fixed bot-config list. Each topic keeps its own cadence:
 * `listDueUserTopics` only returns topics whose `frequency_minutes` has
 * actually elapsed since `last_checked_at`, so a topic checked every 6h
 * and one checked every 15m coexist inside this one bot's 15-minute
 * schedule tick without over- or under-checking either.
 *
 * Needs direct DB access beyond `BotRunContext` (to read `user_topics`),
 * so — like `createMasterAgent`/`createResearchAgent` before it — this is
 * a factory, not a static export; `index.ts` closes over the real pool at
 * registration time.
 */
export function createUserTopicMonitor(pool: pg.Pool): BotDefinition {
  return {
    id: "user-topic-monitor",
    displayName: "User Topic Monitor",
    description: "Checks user-defined topics at each topic's own configured frequency and importance threshold.",
    version: "0.1.0",
    category: "user_topic",
    scheduleCron: "*/15 * * * *",
    defaultConfig: {},
    capabilities: ["research"],
    timeoutMs: 30000,

    async run(ctx: BotRunContext): Promise<BotRunResult> {
      const dueTopics = await listDueUserTopics(pool);
      const findings: NormalizedFinding[] = [];
      let topicsChecked = 0;

      for (const userTopic of dueTopics) {
        const searched = await ctx.callSearchProvider(userTopic.topic, 5);
        await touchUserTopicChecked(pool, userTopic.id);
        if (!searched) continue;
        topicsChecked++;

        for (const article of searched.results) {
          const titleMatches = article.title.toLowerCase().includes(userTopic.topic.toLowerCase());
          const importance = titleMatches ? "medium" : "low";
          // The topic's own threshold is an additional gate on top of the
          // deterministic heuristic — a topic configured for HIGH-only
          // never produces a finding below that, regardless of match.
          if (!meetsImportanceThreshold(importance, userTopic.importance_threshold)) continue;

          findings.push({
            category: "user_topic",
            title: article.title,
            summary: article.snippet,
            importance,
            confidence: titleMatches ? 0.8 : 0.5,
            sourceMetadata: { topic: userTopic.topic, provider: searched.provider, url: article.url, publishedAt: article.publishedAt },
            payload: { topic: userTopic.topic, article },
            dedupKey: `${userTopic.id}::${article.url.toLowerCase()}`,
          });
        }
      }

      return {
        status: "succeeded",
        findings,
        resourceMetadata: { topicsDue: dueTopics.length, topicsChecked },
      };
    },
  };
}
