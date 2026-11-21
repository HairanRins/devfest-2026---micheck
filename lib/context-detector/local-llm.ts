import { existsSync } from "node:fs";
import path from "node:path";
import { AiStep } from "@/lib/context-detector/types";

// Local text fallback (docs/adr-local-fallback.md): Qwen2.5-3B-Instruct (GGUF,
// Q4_K_M) run in-process through node-llama-cpp. Used only when every remote
// provider failed and CONTEXT_DETECTOR_LOCAL_FALLBACK is on. Its results are
// always flagged as indicative by the caller.
//
// node-llama-cpp is an optional dependency: it is loaded lazily, only on the
// first fallback, so server startup is unchanged and the app works without it.

export class LocalModelUnavailableError extends Error {
    readonly code = "LOCAL_MODEL_UNAVAILABLE";
}

const DEFAULT_MODEL_FILE = "local-models/qwen2.5-3b-instruct-q4_k_m.gguf";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const CONTEXT_SIZE = 8192;
const MAX_TOKENS: Record<AiStep, number> = { extraction: 900, analysis: 1600 };

export const isLocalFallbackEnabled = (): boolean =>
    ["on", "true", "1", "yes"].includes(
        (process.env.CONTEXT_DETECTOR_LOCAL_FALLBACK ?? "").trim().toLowerCase(),
    );

export const getLocalModelPath = (): string =>
    path.resolve(process.env.CONTEXT_DETECTOR_LOCAL_MODEL_PATH?.trim() || DEFAULT_MODEL_FILE);

export const getLocalModelName = (): string => path.basename(getLocalModelPath());

const getTimeoutMs = (): number => {
    const value = Number(process.env.CONTEXT_DETECTOR_LOCAL_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
};

// --- Output schemas (grammar-constrained generation) ---------------------------
// Deliberately smaller than the remote contract: only the fields the pipeline
// needs, so a 3B model on CPU writes fewer tokens. normalize.ts fills defaults.

const VERDICTS = [
    "confirmed",
    "refuted",
    "misleading_or_out_of_context",
    "unverifiable",
    "partially_confirmed",
    "opinion_or_non_factual",
];
const LEVELS = ["low", "medium", "high"];

const stringArray = (maxItems: number) => ({
    type: "array",
    items: { type: "string" },
    maxItems,
});

const LOCAL_SCHEMAS: Record<AiStep, object> = {
    extraction: {
        type: "object",
        properties: {
            input_summary: { type: "string" },
            language: { type: "string" },
            claims: {
                type: "array",
                maxItems: 5,
                items: {
                    type: "object",
                    properties: {
                        id: { type: "string" },
                        claim_text: { type: "string" },
                        claim_type: {
                            enum: [
                                "event",
                                "policy_legal",
                                "statistic",
                                "quote",
                                "identity_allegation",
                                "science_health",
                                "causal",
                                "historical",
                                "other",
                            ],
                        },
                        importance: { enum: LEVELS },
                        verification_question: { type: "string" },
                        checkability: {
                            enum: [
                                "verifiable",
                                "partially_verifiable",
                                "not_verifiable",
                                "opinion_or_prediction",
                            ],
                        },
                    },
                },
            },
            search_plan: {
                type: "array",
                maxItems: 5,
                items: {
                    type: "object",
                    properties: {
                        claim_id: { type: "string" },
                        queries: stringArray(3),
                    },
                },
            },
        },
    },
    analysis: {
        type: "object",
        properties: {
            evidence: {
                type: "array",
                maxItems: 12,
                items: {
                    type: "object",
                    properties: {
                        source_id: { type: "string" },
                        claim_ids: stringArray(5),
                        stance: { enum: ["supports", "contradicts", "contextualizes", "neutral"] },
                        relevance: { enum: LEVELS },
                    },
                },
            },
            claim_verdicts: {
                type: "array",
                maxItems: 5,
                items: {
                    type: "object",
                    properties: {
                        claim_id: { type: "string" },
                        verdict: { enum: VERDICTS },
                        explanation: { type: "string" },
                        confidence: { enum: LEVELS },
                        evidence_ids: stringArray(5),
                    },
                },
            },
            overall_verdict: {
                type: "object",
                properties: {
                    label: { enum: VERDICTS },
                    summary: { type: "string" },
                    confidence: { enum: LEVELS },
                    confidence_rationale: { type: "string" },
                    key_evidence_ids: stringArray(5),
                },
            },
            practical_takeaway: { type: "string" },
            limitations: stringArray(3),
        },
    },
};

// --- Minimal typing of the parts of node-llama-cpp we use ----------------------

interface LlamaGrammarLike {
    parse(text: string): unknown;
}
interface LlamaContextLike {
    getSequence(): unknown;
    dispose(): Promise<void>;
}
interface LlamaModelLike {
    createContext(options: { contextSize: number }): Promise<LlamaContextLike>;
}
interface LlamaLike {
    loadModel(options: { modelPath: string }): Promise<LlamaModelLike>;
    createGrammarForJsonSchema(schema: object): Promise<LlamaGrammarLike>;
}
interface ChatSessionLike {
    prompt(
        text: string,
        options: {
            grammar: LlamaGrammarLike;
            temperature: number;
            maxTokens: number;
            signal: AbortSignal;
        },
    ): Promise<string>;
}
interface NodeLlamaCppModule {
    getLlama(): Promise<LlamaLike>;
    LlamaChatSession: new (options: {
        contextSequence: unknown;
        systemPrompt: string;
    }) => ChatSessionLike;
}

interface LoadedModel {
    module: NodeLlamaCppModule;
    llama: LlamaLike;
    model: LlamaModelLike;
}

const PACKAGE_NAME = "node-llama-cpp";
let loading: Promise<LoadedModel> | undefined;
let queue: Promise<unknown> = Promise.resolve();

const loadModel = (): Promise<LoadedModel> => {
    loading ??= (async () => {
        const modelPath = getLocalModelPath();
        if (!existsSync(modelPath)) {
            throw new LocalModelUnavailableError(
                `Modèle local absent (${modelPath}) : lancez « npm run models:download ».`,
            );
        }

        let module: NodeLlamaCppModule;
        try {
            // Non-analysable specifier: keeps the optional package out of the bundle.
            module = (await import(
                /* webpackIgnore: true */ /* turbopackIgnore: true */ PACKAGE_NAME
            )) as NodeLlamaCppModule;
        } catch {
            throw new LocalModelUnavailableError(
                `Paquet ${PACKAGE_NAME} non installé : lancez « npm run models:install ».`,
            );
        }

        const llama = await module.getLlama();
        const model = await llama.loadModel({ modelPath });
        return { module, llama, model };
    })();

    // Let a later request retry after a failed load (e.g. model downloaded since).
    loading.catch(() => {
        loading = undefined;
    });
    return loading;
};

// One generation at a time: a single model shares the machine's CPU and RAM.
const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
};

export const requestLocalJson = (
    systemPrompt: string,
    userPrompt: string,
    step: AiStep,
): Promise<Record<string, unknown>> =>
    serialize(async () => {
        const { module, llama, model } = await loadModel();
        const context = await model.createContext({ contextSize: CONTEXT_SIZE });

        try {
            const session = new module.LlamaChatSession({
                contextSequence: context.getSequence(),
                systemPrompt,
            });
            const grammar = await llama.createGrammarForJsonSchema(LOCAL_SCHEMAS[step]);
            const text = await session.prompt(userPrompt, {
                grammar,
                temperature: 0,
                maxTokens: MAX_TOKENS[step],
                signal: AbortSignal.timeout(getTimeoutMs()),
            });

            const parsed = grammar.parse(text);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                throw new Error("le modèle local n'a pas renvoyé d'objet JSON");
            }
            return parsed as Record<string, unknown>;
        } finally {
            await context.dispose();
        }
    });
