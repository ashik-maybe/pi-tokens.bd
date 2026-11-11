// Shared primitives for the extension.
//
//   timeoutSignal()  — AbortSignal.timeout with a safe fallback; every
//                      tokens.bd network call goes through this (or a Pi-
//                      provided signal) so a hung gateway never hangs a UI.
//   agentDir()       — ~/.pi/agent (Pi's home). Used for tokens-ladder.json.
//                      Auth lives in auth.json which we NEVER read directly;
//                      resolveApiKey goes through Pi's registry instead, so
//                      we can never authenticate as a different key than Pi.
//   readJson()       — tolerant JSON reader (missing/corrupt -> undefined)
//   extractApiKey / resolveApiKey / promptForApiKey — credential plumbing
//
// The tokens.bd API key never lands in env/files/logs we control beyond
// Pi's own credential store; TOKENS_API_KEY is env-only by design.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Credential,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai/compat";

// AbortSignal with timeout where supported; undefined otherwise.
export function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    const t = (AbortSignal as any).timeout;
    return typeof t === "function" ? t.call(AbortSignal, ms) : undefined;
  } catch {
    return undefined;
  }
}

const PROVIDER_ID = "tokens.bd";

export function num(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function validateApiKey(raw: string): string {
  const key = raw.trim();
  if (!key) throw new Error("API key is required.");
  if (!key.startsWith("tok_live_")) {
    throw new Error("Invalid key format. Keys start with tok_live_. Copy one from tokens.bd/dashboard/keys.");
  }
  return key;
}

export async function promptForApiKey(interaction: ProviderAuthInteraction): Promise<string> {
  interaction.signal.throwIfAborted();
  const answer = await interaction.prompt({
    type: "secret",
    message: "Enter your tokens.bd API key (tok_live_...)",
    placeholder: "tok_live_...",
  });
  interaction.signal.throwIfAborted();
  return validateApiKey(answer);
}

export function extractApiKey(credential: Credential | undefined): string | undefined {
  if (!credential) return undefined;
  if (credential.type === "api_key") return credential.key;
  if (credential.type === "oauth") return credential.access;
  // Defensive: tolerate a bare stored shape if older Pi writes it.
  const loose = credential as unknown as { key?: string; access?: string };
  return loose.key ?? loose.access;
}

// Pi owns chat auth (runtime --api-key > stored > models.json > env
// TOKENS_API_KEY) and API-key resolution for the usage poller. Direct
// auth.json reads were removed: they could return a different key than
// the one Pi is actually using.
export function agentDir(): string {
  return join(process.env.HOME ?? "", ".pi", "agent");
}

export function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export async function resolveApiKey(ctx?: any): Promise<string | undefined> {
  const registry = ctx?.modelRegistry;
  if (registry?.getApiKeyForProvider) {
    try {
      const key = await registry.getApiKeyForProvider(PROVIDER_ID);
      if (key) return key;
    } catch {
      // fall through
    }
  }
  if (registry?.getProviderAuth) {
    try {
      const result = await registry.getProviderAuth(PROVIDER_ID);
      if (result?.auth?.apiKey) return result.auth.apiKey;
    } catch {
      // fall through
    }
  }
  // No registry: Pi's env path is the only remaining source.
  return process.env.TOKENS_API_KEY || undefined;
}
