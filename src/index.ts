// Pi extension entrypoint. Kept thin deliberately: wiring only — providers,
// virtual models and hooks are registered here; all logic lives in
// catalog.ts, usage.ts, router.ts, commands.ts.
//
// Architecture notes for devs:
//   - Three providers expose the SAME catalog under three Pi `api` tags.
//     pi-ai dispatches each provider through its OWN concrete `api`
//     implementation, so the variants genuinely speak their wire protocol.
//   - Auth is api-key only. `/login tokens.bd` stores via Pi's credential
//     store; headless runs use TOKENS_API_KEY. The `oauth` block exists so
//     Pi's /login UI has a named entry; it behaves as a static key holder.
//   - "Virtual models" (auto/fast/…/virtual-router) are routed per request
//     by router.ts; they are never persisted as real models.

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
  createModelUsageTracker,
} from "./usage.js";
import { extensionState } from "./state.js";
import { routeForRole, registerVirtualRouter } from "./router.js";
import { registerTokensCommands } from "./commands.js";

export default function (pi: ExtensionAPI) {
  const piApi: ExtensionAPI = pi;

  // Each variant gets its own wire protocol + base URL; the model `api`
  // tag set by fetchNativeModels matches.
  const makeProvider = (id: string, name: string) => {
    const { api, baseUrl } = providerApiAndBaseUrl(id);
    return createProvider({
    id,
    name,
    baseUrl,
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
      // Static-key "oauth" for Pi's interactive login UI. It never refreshes;
      // `expires` is 10 years out and `refresh` is a pass-through.
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
    api,
  });
  };

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

  // Budget-aware router. Picks one model per request from the plan's allowlist;
  // see router.ts for the routing decision and continuation stickiness rules.
  registerVirtualRouter(piApi);

  // Usage polling: once on session_start, then every 60 s. Values are
  // persisted (appendEntry) ONLY when the window/wallet signature changes,
  // so idle sessions don't bloat the session file — see usage.ts refreshUsage.
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

  // Kept for request-id + Retry-After capture. Pi surfaces retry/backoff
  // itself; we only need these to enrich ladder errors (router.ts) and for
  // the `tokens:request-logged` bus event. The cast is required because Pi's
  // hook catalog types don't include this event.
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
    } catch {
      // swallow
    }
  });

  // Session model-usage tally for /tokens history --by-model
  piApi.on("before_provider_request", createModelUsageTracker());

  registerTokensCommands(piApi);
}
