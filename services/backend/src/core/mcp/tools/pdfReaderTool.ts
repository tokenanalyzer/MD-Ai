import { PDFParse } from "pdf-parse";
import type { ToolDefinition, ToolExecutionContext, ToolHandler } from "@mdai/shared-types";
import { safeFetchBinary } from "../../security/ssrfGuard.js";
import { truncateText } from "./resultLimits.js";

const DEFINITION: ToolDefinition = {
  id: "pdf_reader",
  displayName: "PDF Text Extraction",
  description: "Fetches a PDF over HTTPS and extracts its text content, bounded by a size limit and page count.",
  version: "0.1.0",
  inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  outputSchema: {
    type: "object",
    properties: { text: { type: "string" }, pageCount: { type: "integer" }, truncated: { type: "boolean" } },
  },
  source: "builtin",
  mcpMetadata: {},
  requiredCapabilities: ["network"],
  riskLevel: "low",
  requiresApproval: false,
  defaultAccess: "allowed",
  enabled: true,
  health: "unknown",
  timeoutMs: 15000,
  owner: "system",
};

const MAX_PDF_BYTES = 15_000_000;
const MAX_PAGES = 50;

export const pdfReaderTool: ToolHandler = {
  definition: DEFINITION,

  async invoke(input, ctx: ToolExecutionContext) {
    const url = String(input["url"] ?? "").trim();
    if (!url) throw new Error("pdf_reader: 'url' is required");

    const fetched = await safeFetchBinary(url, {
      signal: ctx.signal,
      maxBytes: MAX_PDF_BYTES,
      allowedContentTypePrefixes: ["application/pdf", "application/octet-stream"],
    });
    if (fetched.bytes.byteLength === 0) {
      throw new Error("pdf_reader: fetched an empty file");
    }

    const parser = new PDFParse({ data: fetched.bytes });
    try {
      let info: { total?: number };
      try {
        info = await parser.getInfo();
      } catch (err) {
        throw new Error(`pdf_reader: not a valid PDF (${(err as Error).message})`);
      }
      const pageCount = info.total ?? 0;
      const overPageLimit = pageCount > MAX_PAGES;
      const result = await parser.getText(overPageLimit ? { partial: Array.from({ length: MAX_PAGES }, (_, i) => i + 1) } : undefined);
      const bounded = truncateText(result.text);
      return { text: bounded.text, pageCount, truncated: fetched.truncated || overPageLimit || bounded.truncated };
    } finally {
      await parser.destroy().catch(() => {});
    }
  },
};
