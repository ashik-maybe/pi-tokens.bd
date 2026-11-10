// Pi extension entrypoint. Kept thin deliberately: wiring only.
// Deep logic lives in catalog, usage, errors, commands, utils, config, state.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProvider } from "@earendil-works/pi-ai/compat";
import {
  ALL_ROLES,
  ROLE_THINKING_LEVELS,
  PROVIDER_ID,
  PROVIDER_ID_RESPONSES,
  PROVIDER_ID_MESSAGES,
} from "./config.js";
import {
  promptForApiKey,
} from "./utils.js";
import {
  providerApiAndBaseUrl,
  fetchNativeModels,
} from "./catalog.js";
import {
  refreshUsage as refreshUsageImpl,
  createBeforeProviderRequestHandler,
  createSessionBeforeCompactHandler,
} from "./usage.js";
import { extensionState } from "./state.js";
import { routeForRole, registerVirtualRouter } from "./router.js";
import { registerTokensCommands } from "./commands.js";

export default function (pi: ExtensionAPI) {
  const piApi: ExtensionAPI = pi;

  const provider = providerApiAndBaseUrl(PROVIDER_ID);

  const makeProvider = (id: string, name: string) => createProvider({
    id,
    name,
    baseUrl: provider.baseUrl,
    auth: {
      apiKey: {
        name: "Tokens.bd API key",
        login: async (interaction: any) => ({ type: "api_key", key: await promptForApiKey(interaction) }),
        resolve: async ({ ctx, credential, signal }: { ctx: any; credential: any; signal: AbortSignal }) => {
          signal.throwIfAborted();
          if (credential?.key) return { auth: { apiKey: credential.key }, env: credential.env, source: "stored API key" };
          const fromEnv = await ctx.env("TOKENS_API_KEY");
          signal.throwIfAborted();
          if (fromEnv) return { auth: { apiKey: fromEnv }, source: "TOKENS_API_KEY" };
          return undefined;
        },
      },
      oauth: {
        name: "Tokens.bd API Key",
        login: async (interaction: any) => {
          const key = await promptForApiKey(interaction);
          return { type: "oauth", refresh: "", access: key, expires: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000 } as any;
        },
        refresh: async (credential: any, signal: AbortSignal) => {
          signal.throwIfAborted();
          return credential;
        },
        toAuth: async (credential: any) => ({ apiKey: credential.access }),
      },
    },
    models: [],
    fetchModels: (ctx: any) => fetchNativeModels(ctx, id),
    api: provider.api,
  });

  // Register all three wire protocols.
  piApi.registerProvider(makeProvider(PROVIDER_ID, "Tokens.bd"));
  piApi.registerProvider(makeProvider(PROVIDER_ID_RESPONSES, "Tokens.bd (Responses)"));
  piApi.registerProvider(makeProvider(PROVIDER_ID_MESSAGES, "Tokens.bd (Messages)"));

  // Ladder virtual models.
  for (const role of ALL_ROLES) {
    const label = role.replace("-", " ");
    piApi.registerVirtualModel({
      provider: PROVIDER_ID,
      id: role,
      name: `Tokens ${label} (ladder)`,
      thinkingLevels: ROLE_THINKING_LEVELS[role] ?? ["low", "medium", "high"],
      contextWindow: 1100000,
      maxTokens: 8192,
      route(request: any, ctx: any) {
        return routeForRole(role, request, ctx);
      },
    });
  }

  // Keep compat: legacy auto alias
  piApi.registerVirtualModel({
    provider: PROVIDER_ID,
    id: "auto",
    name: "Auto (ladder: fast)",
    thinkingLevels: ROLE_THINKING_LEVELS.fast,
    contextWindow: 1100000,
    maxTokens: 8192,
    route(request: any, _ctx: any) {
      return routeForRole("fast", request, _ctx);
    },
  });

  // Budget-aware router. Picks one model per request from the plan's allowlist.
  registerVirtualRouter(piApi);

  // Session start poll + usage updates.
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  piApi.on("session_start", async (_e: any, ctx: any) => {
    await refreshUsageImpl({ appendEntry: (k: string, v: any) => piApi.appendEntry(k, v), events: { emit: (n: string, v: any) => piApi.events.emit(n, v) } }, ctx);
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(async () => {
      await refreshUsageImpl({ appendEntry: (k: string, v: any) => piApi.appendEntry(k, v), events: { emit: (n: string, v: any) => piApi.events.emit(n, v) } }, ctx);
    }, 60000);
  });

  piApi.on("session_shutdown", async () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  });

  // Marked with after_provider_response kept for retry/hint capture.
  piApi.on("after_provider_response" as any, async (event: any, _ctx: any) => {
    try {
      const headers = event?.headers ?? {};
      const id = headers["x-tokens-request-id"] ?? headers["X-Tokens-Request-Id"] ?? headers["x-request-id"];
      if (id) {
        extensionState.lastRequestId = String(id);
        piApi.events.emit("tokens:request-logged", { requestId: extensionState.lastRequestId, status: event?.status });
      }
      const retryAfterRaw = headers["retry-after"] ?? headers["Retry-After"];
      if (retryAfterRaw !== undefined && retryAfterRaw !== null) {
        const parsed = Number(retryAfterRaw);
        extensionState.lastRetryAfterSeconds = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
      }
      if (event?.status === 429) {
        try {
          _ctx?.ui?.notify?.(`tokens.bd 429 — wait ${retryAfterRaw}s (Retry-After). /tokens status shows windows.`, "warning");
        } catch {
          // swallow
        }
      }
    } catch {
      // swallow
    }
  });

  // Pre-flight size guard
  piApi.on("before_provider_request", createBeforeProviderRequestHandler(piApi));

  piApi.on("session_before_compact", createSessionBeforeCompactHandler(piApi));

  registerTokensCommands(piApi);
}
