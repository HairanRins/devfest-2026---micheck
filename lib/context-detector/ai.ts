import {
    getLocalModelName,
    isLocalFallbackEnabled,
    requestLocalJson,
} from "@/lib/context-detector/local-llm";
import { AiAttempt, AiProviderInfo, AiStep } from "@/lib/context-detector/types";

export class ContextDetectorConfigurationError extends Error {
    readonly code = "CONFIGURATION_MISSING";
}

export class ContextDetectorAiError extends Error {
    readonly code = "AI_PROVIDER_ERROR";
}

// HTTP failure from a remote provider, kept typed so limits can be detected.
class ProviderHttpError extends Error {
    readonly status: number;
    readonly retryAfterMs?: number;

    constructor(status: number, retryAfterMs?: number) {
        super(`HTTP ${status}`);
        this.status = status;
        this.retryAfterMs = retryAfterMs;
    }
}

const parseRetryAfter = (header: string | null): number | undefined => {
    if (!header) {
        return undefined;
    }
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
    }
    const date = Date.parse(header);
    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
};

const throwIfNotOk = (response: Response): void => {
    if (!response.ok) {
        throw new ProviderHttpError(
            response.status,
            parseRetryAfter(response.headers.get("retry-after")),
        );
    }
};

type AiProviderId = "groq" | "xai" | "mistral" | "gemini" | "huggingface";

interface AiProvider {
    id: AiProviderId;
    label: string;
    apiKey: string;
    baseUrl: string;
    model: string;
    jsonMode: boolean;
}

const DEFAULT_PROVIDER_ORDER: AiProviderId[] = [
    "groq",
    "xai",
    "mistral",
    "gemini",
    "huggingface",
];

const envValue = (...names: string[]): string => {
    for (const name of names) {
        const value = process.env[name]?.trim();
        if (value) {
            return value;
        }
    }
    return "";
};

const isAiProviderId = (value: string): value is AiProviderId =>
    (DEFAULT_PROVIDER_ORDER as string[]).includes(value);

const parseProviderOrder = (): AiProviderId[] => {
    const configured = envValue("CONTEXT_DETECTOR_AI_PROVIDERS")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(isAiProviderId);
    return configured.length ? Array.from(new Set(configured)) : DEFAULT_PROVIDER_ORDER;
};

const buildProvider = (id: AiProviderId): AiProvider | undefined => {
    const definitions: Record<AiProviderId, Omit<AiProvider, "apiKey" | "id">> = {
        groq: {
            label: "Groq",
            baseUrl: envValue(
                "CONTEXT_DETECTOR_GROQ_BASE_URL",
                "CONTEXT_DETECTOR_AI_BASE_URL",
            ) || "https://api.groq.com/openai/v1",
            model:
                envValue("CONTEXT_DETECTOR_GROQ_MODEL", "CONTEXT_DETECTOR_AI_MODEL") ||
                "llama-3.3-70b-versatile",
            jsonMode: true,
        },
        xai: {
            label: "xAI",
            baseUrl: envValue("CONTEXT_DETECTOR_XAI_BASE_URL") || "https://api.x.ai/v1",
            model: envValue("CONTEXT_DETECTOR_XAI_MODEL") || "grok-3-mini",
            jsonMode: true,
        },
        mistral: {
            label: "Mistral",
            baseUrl: envValue("CONTEXT_DETECTOR_MISTRAL_BASE_URL") || "https://api.mistral.ai/v1",
            model: envValue("CONTEXT_DETECTOR_MISTRAL_MODEL") || "mistral-small-latest",
            jsonMode: true,
        },
        gemini: {
            label: "Gemini",
            baseUrl:
                envValue("CONTEXT_DETECTOR_GEMINI_BASE_URL") ||
                "https://generativelanguage.googleapis.com/v1beta",
            model: envValue("CONTEXT_DETECTOR_GEMINI_MODEL") || "gemini-2.5-flash",
            jsonMode: true,
        },
        huggingface: {
            label: "Hugging Face",
            baseUrl:
                envValue("CONTEXT_DETECTOR_HF_BASE_URL") || "https://router.huggingface.co/v1",
            model:
                envValue("CONTEXT_DETECTOR_HF_MODEL") ||
                "mistralai/Mistral-7B-Instruct-v0.3",
            jsonMode: false,
        },
    };

    const keyEnvNames: Record<AiProviderId, string[]> = {
        groq: ["CONTEXT_DETECTOR_GROQ_API_KEY", "CONTEXT_DETECTOR_AI_API_KEY"],
        xai: ["CONTEXT_DETECTOR_XAI_API_KEY"],
        mistral: ["CONTEXT_DETECTOR_MISTRAL_API_KEY"],
        gemini: ["CONTEXT_DETECTOR_GEMINI_API_KEY"],
        huggingface: ["CONTEXT_DETECTOR_HF_API_KEY"],
    };

    const apiKey = envValue(...keyEnvNames[id]);
    if (!apiKey) {
        return undefined;
    }

    return { id, apiKey, ...definitions[id] };
};

export const getAiProviders = (): AiProvider[] =>
    parseProviderOrder()
        .map((id) => buildProvider(id))
        .filter((provider): provider is AiProvider => Boolean(provider));

export const isAiConfigured = (): boolean =>
    getAiProviders().length > 0 || isLocalFallbackEnabled();

export const getAiModel = (): string =>
    getAiProviders()[0]?.model ?? "llama-3.3-70b-versatile";

const extractJsonObject = (content: string): Record<string, unknown> => {
    const cleaned = content
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) {
        throw new ContextDetectorAiError("La réponse IA ne contient pas d'objet JSON.");
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
        throw new ContextDetectorAiError("La réponse IA n'est pas un JSON valide.");
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ContextDetectorAiError("La réponse IA doit être un objet JSON.");
    }

    return parsed as Record<string, unknown>;
};

const requestOpenAiCompatible = async (
    provider: AiProvider,
    systemPrompt: string,
    userPrompt: string,
): Promise<string> => {
    const baseUrl = provider.baseUrl.replace(/\/+$/, "");
    const body: Record<string, unknown> = {
        model: provider.model,
        temperature: 0,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
        ],
    };
    if (provider.jsonMode) {
        body.response_format = { type: "json_object" };
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
    });
    throwIfNotOk(response);

    const payload = (await response.json()) as {
        choices?: { message?: { content?: unknown } }[];
    };
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
        throw new Error("réponse vide");
    }
    return content;
};

const requestGemini = async (
    provider: AiProvider,
    systemPrompt: string,
    userPrompt: string,
): Promise<string> => {
    const baseUrl = provider.baseUrl.replace(/\/+$/, "");
    const response = await fetch(
        `${baseUrl}/models/${encodeURIComponent(provider.model)}:generateContent`,
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-goog-api-key": provider.apiKey,
            },
            body: JSON.stringify({
                system_instruction: { parts: [{ text: systemPrompt }] },
                contents: [{ role: "user", parts: [{ text: userPrompt }] }],
                generationConfig: { temperature: 0, responseMimeType: "application/json" },
            }),
            signal: AbortSignal.timeout(60000),
        },
    );
    throwIfNotOk(response);

    const payload = (await response.json()) as {
        candidates?: { content?: { parts?: { text?: unknown }[] } }[];
    };
    const parts = payload?.candidates?.[0]?.content?.parts ?? [];
    const content = parts
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("")
        .trim();
    if (!content) {
        throw new Error("réponse vide");
    }
    return content;
};

const requestContent = (
    provider: AiProvider,
    systemPrompt: string,
    userPrompt: string,
): Promise<string> =>
    provider.id === "gemini"
        ? requestGemini(provider, systemPrompt, userPrompt)
        : requestOpenAiCompatible(provider, systemPrompt, userPrompt);

// --- Fallback chain -----------------------------------------------------------
// Remote providers in the configured order, then the local model (opt-in).
// A provider that hit its rate limit, or whose key was refused, is skipped for a
// while instead of being called again on every request.

const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000;
const AUTH_COOLDOWN_MS = 5 * 60 * 1000;
const cooldowns = new Map<AiProviderId, number>();

const describeFailure = (error: unknown): { reason: string; cooldownMs?: number } => {
    if (error instanceof ProviderHttpError) {
        if (error.status === 429) {
            return {
                reason: "limite de requêtes atteinte (HTTP 429)",
                cooldownMs: Math.min(
                    error.retryAfterMs ?? RATE_LIMIT_COOLDOWN_MS,
                    MAX_RATE_LIMIT_COOLDOWN_MS,
                ),
            };
        }
        if (error.status === 401 || error.status === 403) {
            return {
                reason: `clé refusée (HTTP ${error.status})`,
                cooldownMs: AUTH_COOLDOWN_MS,
            };
        }
        if (error.status === 402) {
            return { reason: "quota ou crédit épuisé (HTTP 402)", cooldownMs: AUTH_COOLDOWN_MS };
        }
        return { reason: `erreur du fournisseur (HTTP ${error.status})` };
    }
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        return { reason: "délai dépassé" };
    }
    return { reason: error instanceof Error ? error.message : String(error) };
};

export interface StructuredJsonResult {
    data: Record<string, unknown>;
    provider: AiProviderInfo;
}

export const requestStructuredJson = async (
    systemPrompt: string,
    userPrompt: string,
    step: AiStep,
): Promise<StructuredJsonResult> => {
    const providers = getAiProviders();
    const localEnabled = isLocalFallbackEnabled();
    if (providers.length === 0 && !localEnabled) {
        throw new ContextDetectorConfigurationError(
            "Aucun fournisseur IA configuré : ajoutez une clé CONTEXT_DETECTOR_*_API_KEY ou activez CONTEXT_DETECTOR_LOCAL_FALLBACK.",
        );
    }

    const attempts: AiAttempt[] = [];
    for (const provider of providers) {
        const blockedUntil = cooldowns.get(provider.id) ?? 0;
        if (blockedUntil > Date.now()) {
            attempts.push({
                provider: provider.id,
                outcome: "skipped",
                reason: `en pause après une limite ou un refus, nouvel essai dans ${Math.ceil(
                    (blockedUntil - Date.now()) / 1000,
                )} s`,
            });
            continue;
        }

        try {
            const content = await requestContent(provider, systemPrompt, userPrompt);
            const data = extractJsonObject(content);
            cooldowns.delete(provider.id);
            return {
                data,
                provider: {
                    id: provider.id,
                    label: provider.label,
                    model: provider.model,
                    kind: "remote",
                    indicative: false,
                    attempts,
                },
            };
        } catch (error) {
            const { reason, cooldownMs } = describeFailure(error);
            if (cooldownMs) {
                cooldowns.set(provider.id, Date.now() + cooldownMs);
            }
            attempts.push({ provider: provider.id, outcome: "failed", reason });
            console.error("Context Detector AI provider failed:", provider.id, step, reason);
        }
    }

    if (localEnabled) {
        try {
            const data = await requestLocalJson(systemPrompt, userPrompt, step);
            return {
                data,
                provider: {
                    id: "local",
                    label: "Modèle local (node-llama-cpp)",
                    model: getLocalModelName(),
                    kind: "local",
                    indicative: true,
                    attempts,
                },
            };
        } catch (error) {
            const { reason } = describeFailure(error);
            attempts.push({ provider: "local", outcome: "failed", reason });
            console.error("Context Detector local model failed:", step, reason);
        }
    }

    throw new ContextDetectorAiError(
        `Tous les fournisseurs IA ont échoué (${attempts
            .map((attempt) => `${attempt.provider}: ${attempt.reason}`)
            .join(" | ")}).`,
    );
};
