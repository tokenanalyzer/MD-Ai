/**
 * Minimal, dependency-free readable-text extraction from HTML. This is a
 * naive tag-stripper, not a full Readability-style content algorithm — it
 * is honestly scoped as "extraction where possible" (M4.5), not a claim
 * of high-fidelity article extraction.
 */
export function htmlToText(html: string): { title?: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch?.[1] ? decodeEntities(titleMatch[1]).trim() : undefined;

  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const withoutTags = withoutNoise.replace(/<[^>]+>/g, " ");
  const text = decodeEntities(withoutTags).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();

  return { title, text };
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}
