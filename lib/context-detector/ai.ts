export class ContextDetectorConfigurationError extends Error {
    readonly code = "CONFIGURATION_MISSING";
}

export class ContextDetectorAiError extends Error {
    readonly code = "AI_PROVIDER_ERROR";
}

const DEFAULT_AI_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_AI_MODEL = "llama-3.3-70b-versatile";

export const isAiConfigured = (): boolean =>
    Boolean(process.env.CONTEXT_DETECTOR_AI_API_KEY?.trim());

export const getAiModel = (): string =>
    process.env.CONTEXT_DETECTOR_AI_MODEL?.trim() || DEFAULT_AI_MODEL;

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

export const requestStructuredJson = async (
    systemPrompt: string,
    userPrompt: string,
): Promise<Record<string, unknown>> => {
    if (!isAiConfigured()) {
        throw new ContextDetectorConfigurationError(
            "CONTEXT_DETECTOR_AI_API_KEY n'est pas configurée.",
        );
    }

    const baseUrl = (
        process.env.CONTEXT_DETECTOR_AI_BASE_URL?.trim() || DEFAULT_AI_BASE_URL
    ).replace(/\/+$/, "");

    let response: Response;
    try {
        response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${process.env.CONTEXT_DETECTOR_AI_API_KEY}`,
            },
            body: JSON.stringify({
                model: getAiModel(),
                temperature: 0,
                response_format: { type: "json_object" },
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt },
                ],
            }),
            signal: AbortSignal.timeout(60000),
        });
    } catch (error) {
        console.error("Context Detector AI request failed:", error);
        throw new ContextDetectorAiError("Le fournisseur IA est injoignable.");
    }

    if (!response.ok) {
        console.error("Context Detector AI returned status:", response.status);
        throw new ContextDetectorAiError(
            `Le fournisseur IA a répondu avec le statut ${response.status}.`,
        );
    }

    let payload: unknown;
    try {
        payload = await response.json();
    } catch {
        throw new ContextDetectorAiError("Réponse IA illisible.");
    }

    const content = (payload as { choices?: { message?: { content?: unknown } }[] })
        ?.choices?.[0]?.message?.content;

    if (typeof content !== "string" || !content.trim()) {
        throw new ContextDetectorAiError("Le fournisseur IA n'a pas renvoyé de contenu.");
    }

    return extractJsonObject(content);
};
