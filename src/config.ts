// Dev docs live in these headers and the inline notes — this file is the
// endpoint registry. Everything derives from https://tokens.bd:
//
//   BASE_URL            OpenAI-compatible base (chat-completions + responses)
//   MESSAGES_BASE_URL   Anthropic Messages base — NO `/v1` suffix, per docs
//                       (`POST /v1/messages`, "https://tokens.bd/v1/messages")
//   MODELS_URL          Callable model ids (documented; no pricing)
//   CATALOG_URL         Price feed (NOT documented; exists live as of 2026-11)
//   USAGE_URL           Plan/wallet usage windows (documented)
//   COUNT_TOKENS_URL    Count-tokens probe (documented, admission-checked)

export const BASE_URL = "https://tokens.bd/v1";
export const MESSAGES_BASE_URL = "https://tokens.bd";
export const MODELS_URL = "https://tokens.bd/v1/models";
export const CATALOG_URL = "https://tokens.bd/api/models";
export const USAGE_URL = "https://tokens.bd/v1/tokens/usage";
export const COUNT_TOKENS_URL = "https://tokens.bd/v1/messages/count_tokens";

export const PROVIDER_ID = "tokens.bd";
export const PROVIDER_ID_RESPONSES = "tokens.bd-responses";
export const PROVIDER_ID_MESSAGES = "tokens.bd-messages";

// Roles derived from live catalog. `private` is kept as a registered alias
// to `fast` for existing user configs; it has no reliable catalogue signal.
export const ALL_ROLES = ["fast", "coder", "reasoner", "long-context", "private", "research"] as const;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const ROLE_THINKING_LEVELS: Record<string, readonly ThinkingLevel[]> = {
  fast: ["low", "medium"],
  coder: ["low", "medium", "high", "xhigh"],
  reasoner: ["high", "xhigh", "max"],
  "long-context": ["medium", "high", "xhigh"],
  private: ["low", "medium"],
  research: ["medium", "high", "max"],
};
