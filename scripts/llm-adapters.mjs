const PROVIDER_NAMES = ["openai", "anthropic", "dashscope", "deepseek", "openrouter", "ollama", "custom"];
const TRANSIENT_BACKOFF_MS = [1000, 2000, 4000];
const PROFILE_COOLDOWN_MS = 5 * 60 * 1000;

export const PROVIDER_PRESETS = Object.freeze({
  openai: { protocol: "openai", baseUrl: "https://api.openai.com/v1", auth: true },
  anthropic: { protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", auth: true },
  dashscope: { protocol: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", auth: true },
  deepseek: { protocol: "openai", baseUrl: "https://api.deepseek.com/v1", auth: true },
  openrouter: { protocol: "openai", baseUrl: "https://openrouter.ai/api/v1", auth: true },
  ollama: { protocol: "openai", baseUrl: "http://127.0.0.1:11434/v1", auth: false },
  custom: { protocol: "openai", baseUrl: "", auth: true },
});

function normalizeProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  return PROVIDER_NAMES.includes(provider) ? provider : "custom";
}

function normalizeProfile(raw, index, credentialStatus = {}) {
  const provider = normalizeProvider(raw?.provider);
  const preset = PROVIDER_PRESETS[provider];
  const id = String(raw?.id || (index === 0 ? "primary" : `backup-${index}`)).trim();
  return {
    id,
    provider,
    protocol: preset.protocol,
    baseUrl: String(raw?.baseUrl || preset.baseUrl || "").trim(),
    model: String(raw?.model || "").trim(),
    enabled: raw?.enabled !== false,
    priority: Number.isFinite(Number(raw?.priority)) ? Number(raw.priority) : index + 1,
    timeoutMs: Number(raw?.timeoutMs) > 0 ? Number(raw.timeoutMs) : 90000,
    maxOutputTokens: Number(raw?.maxOutputTokens) > 0 ? Number(raw.maxOutputTokens) : 1600,
    auth: raw?.auth === false ? false : preset.auth,
    credentialRef: String(raw?.credentialRef || id),
    credentialConfigured: Boolean(credentialStatus?.[raw?.credentialRef || id]),
    customHeaders: raw?.customHeaders && typeof raw.customHeaders === "object" ? { ...raw.customHeaders } : {},
  };
}

export function normalizeProfiles(settings = {}, credentialStatus = {}) {
  if (Array.isArray(settings.llmProfiles) && settings.llmProfiles.length > 0) {
    return settings.llmProfiles
      .map((profile, index) => normalizeProfile(profile, index, credentialStatus))
      .sort((left, right) => left.priority - right.priority);
  }

  const primary = normalizeProfile({
    id: "primary",
    provider: settings.llmProvider,
    baseUrl: settings.llmBaseUrl,
    model: settings.llmModel,
    credentialRef: "primary",
  }, 0, credentialStatus);

  const profiles = [primary];
  if (settings.llmFallbackEnabled === true && (settings.llmFallbackProvider || settings.llmFallbackModel || settings.llmFallbackBaseUrl)) {
    profiles.push(normalizeProfile({
      id: "backup",
      provider: settings.llmFallbackProvider || settings.llmProvider,
      baseUrl: settings.llmFallbackBaseUrl || settings.llmBaseUrl,
      model: settings.llmFallbackModel,
      credentialRef: "backup",
      priority: 2,
    }, 1, credentialStatus));
  }
  return profiles.sort((left, right) => left.priority - right.priority);
}

function providerUrl(profile) {
  const base = String(profile.baseUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("Provider base URL is missing");
  if (profile.protocol === "anthropic") {
    return /\/messages$/.test(base) ? base : `${base}/messages`;
  }
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

function buildRequest(profile, key, prompt) {
  const headers = {
    "Content-Type": "application/json",
    ...(profile.customHeaders || {}),
  };
  if (key) {
    if (profile.provider === "anthropic") {
      headers["anthropic-version"] = "2023-06-01";
      headers["x-api-key"] = key;
    } else {
      headers.Authorization = `Bearer ${key}`;
    }
  }

  if (profile.protocol === "anthropic") {
    return {
      url: providerUrl(profile),
      headers,
      body: {
        model: profile.model,
        max_tokens: profile.maxOutputTokens,
        messages: [{ role: "user", content: prompt }],
      },
    };
  }

  return {
    url: providerUrl(profile),
    headers,
    body: {
      model: profile.model,
      max_tokens: profile.maxOutputTokens,
      messages: [{ role: "user", content: prompt }],
    },
  };
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "ratelimit";
  if (status >= 500) return "upstream";
  return "http";
}

function extractText(json) {
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(json?.content)) {
    return json.content
      .map((item) => typeof item?.text === "string" ? item.text : "")
      .join("")
      .trim();
  }
  return "";
}

function attemptRecord(profile, attempt, failure, status) {
  return {
    profileId: profile.id,
    provider: profile.provider,
    model: profile.model,
    attempt,
    failure: failure || null,
    status: status || null,
  };
}

function profileHealth(health, profileId) {
  if (!health.has(profileId)) {
    health.set(profileId, { consecutiveFailures: 0, cooldownUntilMs: 0 });
  }
  return health.get(profileId);
}

export async function requestWithFallback({
  profiles = [],
  prompt = "",
  credentialStore,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  health = new Map(),
  now = Date.now,
  maxTransientRetries = 2,
} = {}) {
  const attempts = [];
  const ordered = [...profiles]
    .filter((profile) => profile?.enabled !== false)
    .sort((left, right) => Number(left.priority || 0) - Number(right.priority || 0));

  for (const profile of ordered) {
    const state = profileHealth(health, profile.id);
    const currentTime = Number(now());
    if (state.cooldownUntilMs > currentTime) {
      attempts.push(attemptRecord(profile, 0, "cooldown"));
      continue;
    }
    if (!profile.model) {
      attempts.push(attemptRecord(profile, 0, "configuration"));
      continue;
    }

    let key = "";
    if (profile.auth !== false) {
      try {
        key = String(await credentialStore?.get(profile.credentialRef) || "");
      } catch {
        attempts.push(attemptRecord(profile, 0, "auth"));
        continue;
      }
      if (!key) {
        attempts.push(attemptRecord(profile, 0, "auth"));
        continue;
      }
    }

    let formatRetried = false;
    let transientAttempt = 0;
    while (true) {
      let response;
      let status = null;
      try {
        const request = buildRequest(profile, key, prompt);
        response = await fetchImpl(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: AbortSignal.timeout?.(profile.timeoutMs || 90000),
        });
        status = response.status;
      } catch {
        state.consecutiveFailures += 1;
        attempts.push(attemptRecord(profile, transientAttempt + 1, "network"));
        if (transientAttempt < maxTransientRetries) {
          await sleep(TRANSIENT_BACKOFF_MS[Math.min(transientAttempt, TRANSIENT_BACKOFF_MS.length - 1)]);
          transientAttempt += 1;
          continue;
        }
        break;
      }

      if (!response.ok) {
        const failure = classifyStatus(status);
        attempts.push(attemptRecord(profile, transientAttempt + 1, failure, status));
        if (failure === "auth") break;
        if (failure === "ratelimit" || failure === "upstream") {
          state.consecutiveFailures += 1;
          if (transientAttempt < maxTransientRetries) {
            await sleep(TRANSIENT_BACKOFF_MS[Math.min(transientAttempt, TRANSIENT_BACKOFF_MS.length - 1)]);
            transientAttempt += 1;
            continue;
          }
        }
        break;
      }

      let json;
      try {
        json = await response.json();
      } catch {
        attempts.push(attemptRecord(profile, transientAttempt + 1, "format", status));
        if (!formatRetried) {
          formatRetried = true;
          continue;
        }
        break;
      }

      const text = extractText(json);
      if (!text) {
        attempts.push(attemptRecord(profile, transientAttempt + 1, "format", status));
        if (!formatRetried) {
          formatRetried = true;
          continue;
        }
        break;
      }

      state.consecutiveFailures = 0;
      state.cooldownUntilMs = 0;
      return {
        ok: true,
        text,
        profileId: profile.id,
        provider: profile.provider,
        model: profile.model,
        attempts,
      };
    }

    if (state.consecutiveFailures >= 3) {
      state.cooldownUntilMs = Number(now()) + PROFILE_COOLDOWN_MS;
    }
  }

  return {
    ok: false,
    errorCode: "all-providers-failed",
    attempts,
  };
}
