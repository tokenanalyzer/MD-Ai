/**
 * Defensive JSON extraction from an LLM's text response. Providers vary in
 * how strictly they honor "respond with only JSON" — some wrap it in
 * prose or a code fence despite instructions. Every structured-output call
 * site (intent classification, Research findings, Reviewer verdicts) goes
 * through this rather than a bare `JSON.parse`, and treats a `null`
 * result as a normal, handled case (fail closed to the safest default),
 * never an uncaught exception that would crash the pipeline.
 */
export function extractJson<T>(text: string): T | null {
  const direct = tryParse<T>(text.trim());
  if (direct !== null) return direct;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) {
    const parsed = tryParse<T>(fenced[1].trim());
    if (parsed !== null) return parsed;
  }

  const braceStart = text.indexOf("{");
  if (braceStart === -1) return null;
  let depth = 0;
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(braceStart, i + 1);
        const parsed = tryParse<T>(candidate);
        if (parsed !== null) return parsed;
        break;
      }
    }
  }
  return null;
}

function tryParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
