import type { BotDefinition, BotRunContext, BotRunResult, NormalizedFinding } from "@mdai/shared-types";
import { safeFetch, UnsafeUrlError } from "../security/ssrfGuard.js";

/**
 * M5.8: watches configured/approved sources for new model releases,
 * provider changes, deprecations, capability changes. A "source" is an
 * HTTPS endpoint the owner has approved that returns a small, fixed JSON
 * shape (`{ releases: [...] }`) — deliberately not an RSS/HTML scraper, so
 * every release this bot reports is something a source literally
 * published in a structured field, never inferred or guessed. An empty
 * `sources` list (the seeded default) is a legitimate, quiet
 * configuration — it means zero findings, not zero function.
 */

interface ReleaseEntry {
  id?: string;
  name?: string;
  version?: string;
  provider?: string;
  kind?: "release" | "deprecation" | "capability_change" | "provider_change";
  publishedAt?: string;
  url?: string;
  description?: string;
}

interface SourcePayload {
  releases?: ReleaseEntry[];
}

function toFinding(sourceUrl: string, entry: ReleaseEntry): NormalizedFinding | undefined {
  const identity = entry.id ?? entry.version ?? entry.name;
  if (!identity || !entry.name) return undefined;

  return {
    category: "ai_release",
    title: `${entry.provider ? `${entry.provider}: ` : ""}${entry.name}${entry.version ? ` ${entry.version}` : ""}`,
    summary: entry.description ?? `New ${entry.kind ?? "release"} reported by ${sourceUrl}.`,
    // A deprecation/capability change is worth surfacing more readily than
    // a routine release, since it can break something the owner depends on.
    importance: entry.kind === "deprecation" ? "high" : "medium",
    confidence: 1,
    sourceMetadata: { sourceUrl, url: entry.url, provider: entry.provider },
    payload: { ...entry },
    dedupKey: `${sourceUrl}::${identity}`,
  };
}

export const aiModelReleaseMonitor: BotDefinition = {
  id: "ai-model-release-monitor",
  displayName: "AI / Model Release Monitor",
  description:
    "Watches configured/approved sources for new model releases, provider changes, deprecations, and capability changes. Never fabricates a release — only reports what a source actually published.",
  version: "0.1.0",
  category: "ai_release",
  scheduleCron: "*/30 * * * *",
  defaultConfig: { sources: [] },
  capabilities: ["research"],
  timeoutMs: 30000,

  async run(ctx: BotRunContext): Promise<BotRunResult> {
    const sources = Array.isArray(ctx.config["sources"]) ? (ctx.config["sources"] as string[]) : [];
    const findings: NormalizedFinding[] = [];
    let sourcesChecked = 0;
    let sourcesFailed = 0;

    for (const sourceUrl of sources) {
      try {
        const res = await safeFetch(sourceUrl, { signal: ctx.signal, maxBytes: 500_000, allowedContentTypePrefixes: ["application/json"] });
        sourcesChecked++;
        const payload = JSON.parse(res.body) as SourcePayload;
        for (const entry of payload.releases ?? []) {
          const finding = toFinding(sourceUrl, entry);
          if (finding) findings.push(finding);
        }
      } catch (err) {
        sourcesFailed++;
        if (err instanceof UnsafeUrlError) throw err; // a misconfigured/unsafe source is a config problem, not a transient failure
      }
    }

    return {
      status: "succeeded",
      findings,
      resourceMetadata: { sourcesConfigured: sources.length, sourcesChecked, sourcesFailed },
    };
  },
};
