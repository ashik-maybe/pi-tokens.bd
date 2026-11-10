// Machine-readable gateway error classification. Both wire shapes are
// supported: OpenAI-style `{"error":{"code":"..."}}` and Anthropic-style
// `{"type":"error","error":{"type":"...","code":"..."}}`.

export const ERROR_MAP: Record<string, string> = {
  free_limit_reached: "Plan usage windows used up. Wait for reset (shown in /tokens-status) or upgrade plan.",
  missing_api_key: "No API key. Run /login tokens.bd.",
  invalid_api_key: "Invalid API key. Recopy or create a new one.",
  key_inactive: "Key revoked or rotated. Use the current secret.",
  key_expired: "Key expired. Create a new one.",
  account_suspended: "Account suspended. Contact support.",
  model_not_allowed_on_key: "Model not in this key's allow-list.",
  monthly_spend_cap_exceeded: "Monthly spend cap reached. Wait for next month or use another key. Try /tokens-suggest for a cheaper model.",
  tier_permission_denied: "Plan doesn't include this model. Upgrade or top up wallet. Try /tokens-suggest for a cheaper model.",
  model_not_found: "Model not found. Check /v1/models.",
  insufficient_credits: "Insufficient credits. Top up or lower max_tokens. Try /tokens-suggest for a cheaper model.",
  no_funding: "No active plan and no wallet balance. Subscribe or top up. Try /tokens-suggest for a cheaper model.",
  outstanding_debt: "Negative balance. Top up to clear it.",
  member_cap_reached: "Team member cap reached. Ask admin.",
  rate_limited: "Rate limited (RPM). Wait Retry-After seconds. Scattered parallelism helps more than retries.",
  concurrency_limit: "Too many in flight. Reduce parallelism. Retry-After: 2s.",
  window_exhausted: "Usage window exhausted. Wait for reset (timing in /tokens-status). Do not retry in a loop.",
  model_limit_reached: "Model allowance used up. Switch models or wait. Try /tokens-suggest for a cheaper model.",
  rate_limit_exceeded: "Upstream rate limited. Retry with backoff.",
  upstream_unreachable: "Upstream unreachable. Retry with backoff.",
  upstream_error: "Upstream server error. Retry with backoff.",
  upstream_timeout: "Upstream timed out (600s). Retry or reduce request size.",
  no_upstream_available: "No upstream for this model. Try another.",
  model_not_priced: "Model not priced. Try another model.",
  request_entity_too_large: "Request too large (>10MB). Trim context.",
  invalid_request: "Invalid request. Check model field and Content-Type.",
  model_not_available: "Model can't be served right now. Pick another.",
  endpoint_not_supported_for_model: "Endpoint not supported. Use /v1/chat/completions.",
  upstream_auth_error: "Upstream auth failed (not your key). Retry later.",
  anthropic_protocol_disabled: "Messages API disabled. Use Chat Completions.",
  lookup_failed: "Internal lookup failed. Retry once or twice, then support.",
  admission_error: "Request admission failed. Retry once or twice, then support.",
  catalog_error: "Model catalog error. Retry once or twice, then support.",
  usage_unavailable: "Usage service unavailable. Retry later.",
  unsupported_endpoint: "Path or method not supported. See /v1/models and usage.",
  context_length_exceeded: "Context window exceeded. Compaction should retry; ladder escalates to a larger model when available.",
  context_overflow: "Context window exceeded. /compact, then retry.",
};

const RETRYABLE_CODES = new Set([
  "rate_limited",
  "concurrency_limit",
  "rate_limit_exceeded",
  "upstream_unreachable",
  "upstream_error",
  "upstream_timeout",
  "no_upstream_available",
  "model_not_priced",
  "model_not_available",
  "upstream_auth_error",
  "lookup_failed",
  "admission_error",
  "catalog_error",
  "usage_unavailable",
  "context_length_exceeded",
  "context_overflow",
  "context_length",
]);

const NON_RETRYABLE_CODES = new Set([
  "missing_api_key",
  "invalid_api_key",
  "key_inactive",
  "key_expired",
  "account_suspended",
  "model_not_allowed_on_key",
  "monthly_spend_cap_exceeded",
  "tier_permission_denied",
  "insufficient_credits",
  "no_funding",
  "outstanding_debt",
  "member_cap_reached",
  "window_exhausted",
  "free_limit_reached",
  "model_limit_reached",
  "invalid_request",
  "request_entity_too_large",
  "endpoint_not_supported_for_model",
  "anthropic_protocol_disabled",
  "model_not_found",
  "unsupported_endpoint",
]);

// Extract the machine-readable code from a gateway error body. Both shapes
// carry it: OpenAI-style `{"error":{"code":"..."}}` and Anthropic-style
// `{"type":"error","error":{"type":"...","code":"..."}}`. Falls back to a
// bare code-looking token or status digits in free text.
export function extractErrorCode(errorMessage: string): string | undefined {
  const text = errorMessage ?? "";
  const jsonMatch = text.match(/"code"\s*:\s*"([A-Za-z0-9_-]{2,64})"/);
  if (jsonMatch) return jsonMatch[1].toLowerCase();
  const altMatch = text.match(/\b(missing_api_key|invalid_api_key|key_inactive|key_expired|account_suspended|model_not_allowed_on_key|monthly_spend_cap_exceeded|tier_permission_denied|model_not_found|insufficient_credits|no_funding|outstanding_debt|member_cap_reached|rate_limited|concurrency_limit|window_exhausted|model_limit_reached|free_limit_reached|rate_limit_exceeded|upstream_unreachable|upstream_error|upstream_timeout|no_upstream_available|model_not_priced|model_not_available|request_entity_too_large|invalid_request|endpoint_not_supported_for_model|anthropic_protocol_disabled|lookup_failed|admission_error|catalog_error|usage_unavailable|unsupported_endpoint|context_length_exceeded|context_overflow)\b/i);
  return altMatch ? altMatch[1].toLowerCase() : undefined;
}

export function classifyFailure(errorMessage: string): "retryable" | "non_retryable" {
  const text = (errorMessage ?? "").toLowerCase();
  const code = extractErrorCode(text);
  // Billing, auth and cap errors: retrying cannot fix them.
  if (code && NON_RETRYABLE_CODES.has(code)) return "non_retryable";
  // Known-transient upstream codes.
  if (code && RETRYABLE_CODES.has(code)) return "retryable";
  for (const retryable of RETRYABLE_CODES) {
    if (text.includes(retryable)) return "retryable";
  }
  // tokens.bd bodies carry status numbers and/or ChatGPT-style codes.
  const statusMatch = text.match(/\b(4\d\d|5\d\d)\b/);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  if (status === 429 || (status !== undefined && status >= 500)) return "retryable";
  if (status !== undefined && status >= 400 && status < 500) return "non_retryable";
  // Unknown: never burn budget retrying a likely 4xx/billing error.
  if (text.includes("context")) return "retryable";
  return "non_retryable";
}

export function errorHint(errorMessage: string): string {
  const code = extractErrorCode(errorMessage ?? "");
  if (code) {
    const hint = ERROR_MAP[code];
    if (hint) return hint;
  }
  const text = (errorMessage ?? "").toLowerCase();
  for (const [mapped, hint] of Object.entries(ERROR_MAP)) {
    if (text.includes(mapped)) return hint;
  }
  return errorMessage ? errorMessage.slice(0, 240) : "Request failed.";
}
