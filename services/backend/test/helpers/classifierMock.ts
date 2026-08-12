/**
 * Master now makes an intent-classification model call before its
 * user-facing synthesis call (M3.2). Integration tests that mock provider
 * HTTP need a canned reply for that first call too — matched on request
 * body content (the classifier's system prompt is distinctive), not
 * request order, since which provider AUTO-scoring picks for the
 * (unpreferenced) classification call isn't something these tests pin
 * down deterministically.
 */
export const NO_DELEGATE_CLASSIFICATION = JSON.stringify({
  delegate: false,
  capability: null,
  taskObjective: null,
  memoryCommand: null,
  memoryCandidate: null,
});

export function isClassifierRequestBody(body: string): boolean {
  return body.includes("intent classifier");
}
