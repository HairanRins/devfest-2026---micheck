import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

const ROOT = path.resolve(import.meta.dirname, "..");
export const BASE_URL = "http://localhost:3000";

// --- Environment ---------------------------------------------------------------

// Every test starts from a clean configuration: no key, no search, local fallback off.
export const resetEnv = (vars: Record<string, string> = {}): void => {
    for (const name of Object.keys(process.env)) {
        if (name.startsWith("CONTEXT_DETECTOR_")) {
            delete process.env[name];
        }
    }
    Object.assign(process.env, vars);
};

export const GROQ_ONLY = {
    CONTEXT_DETECTOR_AI_PROVIDERS: "groq",
    CONTEXT_DETECTOR_GROQ_API_KEY: "test-groq-key",
};

export const GROQ_THEN_GEMINI = {
    CONTEXT_DETECTOR_AI_PROVIDERS: "groq,gemini",
    CONTEXT_DETECTOR_GROQ_API_KEY: "test-groq-key",
    CONTEXT_DETECTOR_GEMINI_API_KEY: "test-gemini-key",
};

export const WITH_TAVILY = { CONTEXT_DETECTOR_TAVILY_API_KEY: "test-tavily-key" };

// --- Simulated network -----------------------------------------------------------

export interface RecordedCall {
    host: string;
    url: string;
    body: Record<string, unknown>;
}

type Handler = (call: RecordedCall) => Response | Promise<Response>;

const realFetch = globalThis.fetch;
export let fetchCalls: RecordedCall[] = [];

// Routes every outgoing request by host. Any host without a handler fails the
// test, so no test can reach the real network.
export const mockFetch = (handlers: Record<string, Handler>): void => {
    fetchCalls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        const host = new URL(url).host;
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const call = { host, url, body };
        fetchCalls.push(call);
        const handler = handlers[host];
        if (!handler) {
            throw new Error(`Unexpected network call in test: ${url}`);
        }
        return handler(call);
    }) as typeof fetch;
};

export const restoreFetch = (): void => {
    globalThis.fetch = realFetch;
};

export const callsTo = (host: string): RecordedCall[] => fetchCalls.filter((call) => call.host === host);

export const HOSTS = {
    groq: "api.groq.com",
    gemini: "generativelanguage.googleapis.com",
    tavily: "api.tavily.com",
};

// --- AI and search answers ---------------------------------------------------------

export const isExtractionCall = (call: RecordedCall): boolean => {
    const messages = call.body.messages as { content: string }[] | undefined;
    const geminiSystem = (call.body.system_instruction as { parts: { text: string }[] } | undefined)
        ?.parts[0]?.text;
    return /Étape 1/.test(messages?.[0]?.content ?? geminiSystem ?? "");
};

export const openAiAnswer = (data: unknown): Response =>
    Response.json({ choices: [{ message: { content: JSON.stringify(data) } }] });

export const geminiAnswer = (data: unknown): Response =>
    Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) } ] } }] });

export const httpError = (status: number, headers: Record<string, string> = {}): Response =>
    new Response("", { status, headers });

export const EXTRACTION = {
    input_summary: "Publication affirmant une nouvelle loi sur les espèces.",
    language: "fr",
    claims: [
        {
            id: "C1",
            claim_text: "Une loi interdit les paiements en espèces au-delà de 10 € dès demain en France.",
            claim_type: "policy_legal",
            importance: "high",
            checkability: "verifiable",
            verification_question: "Une telle loi existe-t-elle ?",
        },
    ],
    search_plan: [{ claim_id: "C1", queries: ["loi paiement espèces 10 euros"] }],
};

// The model cites S1 and tries to rewrite its excerpt, date and URL.
export const ANALYSIS = {
    evidence: [
        {
            source_id: "S1",
            claim_ids: ["C1"],
            stance: "contradicts",
            relevance: "high",
            url: "https://invented.example/fake",
            excerpt: "CITATION INVENTÉE PAR LE MODÈLE",
            published_date: "2099-01-01",
        },
    ],
    claim_verdicts: [
        {
            claim_id: "C1",
            verdict: "refuted",
            explanation: "Le plafond légal reste de 1 000 €.",
            confidence: "high",
            evidence_ids: ["S1"],
        },
    ],
    overall_verdict: {
        label: "refuted",
        summary: "Aucune loi de ce type.",
        confidence: "high",
        confidence_rationale: "Source officielle.",
        key_evidence_ids: ["S1"],
    },
    practical_takeaway: "Ne partagez pas sans source officielle.",
    limitations: [],
};

export const SEARCH_RESULT = {
    title: "Paiement en espèces : quelles limites ?",
    url: "https://www.service-public.fr/particuliers/vosdroits/F10999",
    content: "Le paiement en espèces est limité à 1 000 € entre un particulier et un professionnel.",
    published_date: "2025-01-15",
};

// A provider that answers both pipeline steps correctly.
export const answersBothSteps =
    (format: (data: unknown) => Response) =>
    (call: RecordedCall): Response =>
        format(isExtractionCall(call) ? EXTRACTION : ANALYSIS);

export const tavilyAnswer = (): Response => Response.json({ results: [SEARCH_RESULT] });

// --- Requests ----------------------------------------------------------------------

export const jsonRequest = (route: string, body: unknown): NextRequest =>
    new NextRequest(`${BASE_URL}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
    });

export const getRequest = (route: string): NextRequest => new NextRequest(`${BASE_URL}${route}`);

export type FormField = [name: string, value: Blob | string, fileName?: string];

export const multipartRequest = (fields: FormField[]): NextRequest => {
    const form = new FormData();
    for (const [name, value, fileName] of fields) {
        if (typeof value === "string") {
            form.append(name, value);
        } else {
            form.append(name, value, fileName);
        }
    }
    return new NextRequest(`${BASE_URL}/api/context-detector/media-signals`, {
        method: "POST",
        body: form,
    });
};

// Copied into a plain Uint8Array: TypeScript 5.9 does not accept a Buffer as a BlobPart.
export const fixture = (name: string): Uint8Array<ArrayBuffer> =>
    new Uint8Array(readFileSync(path.join(ROOT, "tests/fixtures/images", name)));

export const imageBlob = (name: string, type: string): Blob => new Blob([fixture(name)], { type });

export const readJson = async <T = Record<string, unknown>>(
    response: Response,
): Promise<{ status: number; body: T }> => ({
    status: response.status,
    body: (await response.json()) as T,
});
