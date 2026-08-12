import "../setupEnv.js";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { getTestPool, resetTestData, closeTestPool } from "../helpers/testDb.js";
import { buildTestAgentRegistry } from "../helpers/appDeps.js";
import { EventBus } from "../../src/core/events/eventBus.js";
import { invokeTool } from "../../src/core/mcp/mcpHost.js";

const pool = await getTestPool();
const redis = new Redis(process.env.REDIS_URL as string);

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

beforeEach(async () => {
  await resetTestData(pool);
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
});

afterAll(async () => {
  await redis.quit();
  await closeTestPool();
});

// A hand-built, deliberately minimal (no real xref table — pdf-parse's
// underlying pdfjs falls back to scanning for "obj" markers) but valid
// PDF, small enough to inline here rather than shipping a binary fixture.
const MINIMAL_PDF = `%PDF-1.1
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
5 0 obj << /Length 44 >>
stream
BT /F1 12 Tf 10 50 Td (Hello PDF) Tj ET
endstream
endobj
trailer << /Root 1 0 R /Size 6 >>
%%EOF`;

/**
 * M4.16: local (non-Oracle) latency measurement per tool, isolated from
 * real network/provider latency (HTTP is mocked here) — this measures
 * MD AI's own per-call overhead (SSRF checks, DB writes, event
 * publishing, and for pdf_reader real parsing work), not real-world
 * search/fetch time. Same honesty scoping as the M3 performance section.
 */
describe("Per-tool invocation latency (M4.16)", () => {
  it("records a latency_ms for every one of the 7 built-in tools and reports them", async () => {
    const { toolRegistry } = buildTestAgentRegistry(pool);
    const eventBus = new EventBus(pool);
    const deps = { pool, eventBus, toolRegistry };

    mockAgent
      .get("https://api.search.brave.com")
      .intercept({ path: (p: string) => p.startsWith("/res/v1/web/search"), method: "GET" })
      .reply(200, { web: { results: [{ title: "T", url: "https://example.com/page", description: "d" }] } });
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/page", method: "GET" })
      .reply(200, "<html><body><p>hello</p></body></html>", { headers: { "content-type": "text/html" } });
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/file.txt", method: "GET" })
      .reply(200, "plain text content", { headers: { "content-type": "text/plain" } });
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/doc.pdf", method: "GET" })
      .reply(200, MINIMAL_PDF, { headers: { "content-type": "application/pdf" } });
    mockAgent
      .get("https://example.com")
      .intercept({ path: "/json", method: "GET" })
      .reply(200, JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });

    await invokeTool(deps, { toolId: "calculator", agentId: "research", input: { expression: "2+2" }, toolKeys: {} });
    await invokeTool(deps, { toolId: "time_date", agentId: "research", input: {}, toolKeys: {} });
    await invokeTool(deps, { toolId: "web_search", agentId: "research", input: { query: "x" }, toolKeys: { brave: "k" } });
    await invokeTool(deps, { toolId: "url_reader", agentId: "research", input: { url: "https://example.com/page" }, toolKeys: {} });
    await invokeTool(deps, { toolId: "file_reader", agentId: "research", input: { url: "https://example.com/file.txt" }, toolKeys: {} });
    await invokeTool(deps, { toolId: "pdf_reader", agentId: "research", input: { url: "https://example.com/doc.pdf" }, toolKeys: {} });
    await invokeTool(
      deps,
      { toolId: "generic_http_get", agentId: "research", input: { url: "https://example.com/json" }, toolKeys: {} },
    );

    const rows = await pool.query<{ tool_id: string; status: string; latency_ms: number }>(
      "SELECT tool_id, status, latency_ms FROM tool_invocations ORDER BY created_at",
    );
    expect(rows.rows).toHaveLength(7);
    expect(rows.rows.every((r) => r.status === "succeeded")).toBe(true);
    expect(rows.rows.every((r) => typeof r.latency_ms === "number" && r.latency_ms >= 0)).toBe(true);

    // eslint-disable-next-line no-console
    console.log(
      "[M4.16] per-tool latency (ms, mocked HTTP — excludes real network/search-provider time):",
      Object.fromEntries(rows.rows.map((r) => [r.tool_id, r.latency_ms])),
    );

    // Loose upper bound — a smoke check against an obviously broken/slow
    // handler, not a tight production SLA.
    expect(rows.rows.every((r) => r.latency_ms < 5000)).toBe(true);
  });
});
