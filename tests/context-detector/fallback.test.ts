// Integration tests: the primary AI provider fails and the fallback answers
// (lib/context-detector/ai.ts, docs/adr-local-fallback.md).
// 1. Remote fallback: Groq (primary) fails → Gemini (secondary) answers.
// 2. Local fallback: every remote provider fails → local model answers, and the
//    result is marked "indicative" (confidence capped at low, banner, limitation).
// The local model is the in-repo fake of node-llama-cpp (tests/fixtures/fakes).
// Runs in its own process: provider pauses (cooldowns) are kept in memory.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { POST as postClaims } from "@/app/api/(client)/context-detector/claims/route";
import { POST as postInvestigate } from "@/app/api/(client)/context-detector/investigate/route";
import { INDICATIVE_LIMITATION } from "@/lib/context-detector/normalize";
import type { ClaimsResponse, InvestigationResponse } from "@/lib/context-detector/types";
import {
    ANALYSIS,
    answersBothSteps,
    callsTo,
    EXTRACTION,
    geminiAnswer,
    GROQ_THEN_GEMINI,
    HOSTS,
    httpError,
    jsonRequest,
    mockFetch,
    openAiAnswer,
    readJson,
    resetEnv,
    restoreFetch,
    SEARCH_RESULT,
    tavilyAnswer,
    WITH_TAVILY,
} from "../helpers";

const CONTENT = {
    content: { type: "text", text: "Une nouvelle loi interdit les paiements en espèces au-delà de 10 €." },
    options: { language: "fr" },
};

const claims = async () =>
    readJson<ClaimsResponse & { message?: string }>(
        await postClaims(jsonRequest("/api/context-detector/claims", CONTENT)),
    );

const investigate = async () =>
    readJson<InvestigationResponse & { message?: string }>(
        await postInvestigate(jsonRequest("/api/context-detector/investigate", CONTENT)),
    );

// "Retry-After: 0" means no pause, so each test starts with every provider available.
const rateLimited = () => httpError(429, { "retry-after": "0" });

const fakeModelPath = (): string => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "micheck-llm-")), "fake-qwen.gguf");
    writeFileSync(file, "fake");
    return file;
};

type FakeLlama = { answers: Record<string, unknown>; calls: Record<string, unknown>[]; loads: number };
const fakeLlama = (): FakeLlama =>
    ((globalThis as { __fakeLlama?: FakeLlama }).__fakeLlama ??= { answers: {}, calls: [], loads: 0 });

beforeEach(() => {
    resetEnv({ ...GROQ_THEN_GEMINI, ...WITH_TAVILY });
    mock.method(console, "error", () => undefined);
    const llama = fakeLlama();
    llama.answers = { extraction: EXTRACTION, analysis: ANALYSIS };
    llama.calls = [];
});

afterEach(() => {
    restoreFetch();
    mock.restoreAll();
});

describe("Primary provider fails → remote fallback answers", () => {
    const failures: [string, () => Response | Promise<Response>, RegExp][] = [
        ["rate limit (429)", rateLimited, /limite de requêtes atteinte \(HTTP 429\)/],
        ["server error (500)", () => httpError(500), /erreur du fournisseur \(HTTP 500\)/],
        ["answer without JSON", () => openAiAnswer("pas du JSON") , /JSON/],
        [
            "timeout",
            () => {
                throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
            },
            /délai dépassé/,
        ],
    ];

    for (const [name, primaryFailure, reason] of failures) {
        it(`/claims: Gemini answers when Groq fails with ${name}`, async () => {
            mockFetch({ [HOSTS.groq]: primaryFailure, [HOSTS.gemini]: answersBothSteps(geminiAnswer) });

            const { status, body } = await claims();

            assert.equal(status, 200);
            assert.equal(body.generated_by.id, "gemini");
            assert.equal(body.generated_by.kind, "remote");
            assert.equal(body.indicative, false);
            assert.equal(body.generated_by.attempts.length, 1);
            assert.equal(body.generated_by.attempts[0].provider, "groq");
            assert.equal(body.generated_by.attempts[0].outcome, "failed");
            assert.match(body.generated_by.attempts[0].reason, reason);
        });
    }

    it("/investigate: both steps answered by Gemini, result not indicative", async () => {
        mockFetch({
            [HOSTS.groq]: rateLimited,
            [HOSTS.gemini]: answersBothSteps(geminiAnswer),
            [HOSTS.tavily]: tavilyAnswer,
        });

        const { status, body } = await investigate();

        assert.equal(status, 201);
        assert.equal(body.dossier.generated_by.extraction.id, "gemini");
        assert.equal(body.dossier.generated_by.analysis.id, "gemini");
        assert.equal(body.dossier.indicative, false);
        assert.equal(body.dossier.claim_verdicts[0].confidence, "high");
        assert.match(body.report ?? "", /Fournisseur IA :\*\* Gemini \(gemini-2\.5-flash\)/);
        assert.equal(callsTo(HOSTS.groq).length, 2, "Groq is tried for each step");
    });

    it("the primary is used again as soon as it recovers", async () => {
        mockFetch({ [HOSTS.groq]: answersBothSteps(openAiAnswer), [HOSTS.gemini]: () => httpError(500) });

        const { body } = await claims();

        assert.equal(body.generated_by.id, "groq");
        assert.equal(callsTo(HOSTS.gemini).length, 0);
    });

    it("returns 502 listing every attempt when all remote providers fail and the local fallback is off", async () => {
        mockFetch({ [HOSTS.groq]: rateLimited, [HOSTS.gemini]: () => httpError(503) });

        const { status, body } = await claims();

        assert.equal(status, 502);
        assert.match(body.message ?? "", /groq: limite de requêtes atteinte \(HTTP 429\)/);
        assert.match(body.message ?? "", /gemini: erreur du fournisseur \(HTTP 503\)/);
        assert.equal(fakeLlama().calls.length, 0, "the local model is not called when off");
    });
});

describe("All remote providers fail → local model answers, marked indicative", () => {
    beforeEach(() => {
        Object.assign(process.env, {
            CONTEXT_DETECTOR_LOCAL_FALLBACK: "on",
            CONTEXT_DETECTOR_LOCAL_MODEL_PATH: fakeModelPath(),
        });
        mockFetch({
            [HOSTS.groq]: rateLimited,
            [HOSTS.gemini]: () => httpError(503),
            [HOSTS.tavily]: tavilyAnswer,
        });
    });

    it("/claims: answered by the local model, with the failed attempts", async () => {
        const { status, body } = await claims();

        assert.equal(status, 200);
        assert.equal(body.generated_by.id, "local");
        assert.equal(body.generated_by.kind, "local");
        assert.equal(body.generated_by.model, "fake-qwen.gguf");
        assert.equal(body.indicative, true);
        assert.deepEqual(
            body.generated_by.attempts.map((attempt) => `${attempt.provider}:${attempt.outcome}`),
            ["groq:failed", "gemini:failed"],
        );
        assert.equal(body.claims[0].id, "C1");
    });

    it("/investigate: confidence capped at low, limitation and banner added", async () => {
        const { status, body } = await investigate();
        const { dossier } = body;

        assert.equal(status, 201);
        assert.equal(dossier.generated_by.extraction.kind, "local");
        assert.equal(dossier.generated_by.analysis.kind, "local");
        assert.equal(dossier.indicative, true);

        // The verdict label is kept; only the confidence is capped.
        assert.equal(dossier.claim_verdicts[0].verdict, "refuted");
        assert.equal(dossier.claim_verdicts[0].confidence, "low");
        assert.equal(dossier.overall_verdict.confidence, "low");
        assert.equal(dossier.claim_verdicts[0].limitations[0], INDICATIVE_LIMITATION);
        assert.equal(dossier.limitations[0], INDICATIVE_LIMITATION);

        assert.match(body.report ?? "", /⚠️ \*\*Résultat indicatif\*\*/);
        assert.match(body.report ?? "", /Modèle local \(node-llama-cpp\) \(fake-qwen\.gguf\) — indicatif/);
    });

    it("/investigate: the anti-fabrication rules still apply to the local model (PRODUCT_SCOPE §6)", async () => {
        const { body } = await investigate();
        const [evidence] = body.dossier.evidence ?? [];

        assert.equal(evidence.url, SEARCH_RESULT.url);
        assert.equal(evidence.excerpt, SEARCH_RESULT.content);
        assert.doesNotMatch(JSON.stringify(body), /invented\.example|CITATION INVENTÉE/);
    });

    it("calls the local model with a JSON schema per step, temperature 0 and a time limit", async () => {
        await investigate();
        const calls = fakeLlama().calls as { step: string; temperature: number; maxTokens: number; hasSignal: boolean }[];

        assert.deepEqual(
            calls.map((call) => call.step),
            ["extraction", "analysis"],
        );
        assert.ok(calls.every((call) => call.temperature === 0 && call.hasSignal));
        assert.deepEqual(
            calls.map((call) => call.maxTokens),
            [900, 1600],
        );
    });

    it("answers locally with no remote key at all (offline mode)", async () => {
        delete process.env.CONTEXT_DETECTOR_GROQ_API_KEY;
        delete process.env.CONTEXT_DETECTOR_GEMINI_API_KEY;

        const { status, body } = await claims();

        assert.equal(status, 200);
        assert.equal(body.generated_by.id, "local");
        assert.deepEqual(body.generated_by.attempts, []);
        assert.equal(callsTo(HOSTS.groq).length + callsTo(HOSTS.gemini).length, 0);
    });
});

// Last: these tests put providers on pause for the rest of the process.
describe("Rate-limited or refused providers are paused, not called again", () => {
    it("skips Groq without calling it after a 429 with Retry-After, and Gemini answers", async () => {
        mockFetch({
            [HOSTS.groq]: () => httpError(429, { "retry-after": "120" }),
            [HOSTS.gemini]: answersBothSteps(geminiAnswer),
        });

        const first = await claims();
        assert.equal(first.body.generated_by.attempts[0].outcome, "failed");
        const groqCallsAfterFirst = callsTo(HOSTS.groq).length;

        const second = await claims();

        assert.equal(second.status, 200);
        assert.equal(second.body.generated_by.id, "gemini");
        assert.equal(callsTo(HOSTS.groq).length, groqCallsAfterFirst, "Groq must not be called again");
        assert.equal(second.body.generated_by.attempts[0].outcome, "skipped");
        assert.match(second.body.generated_by.attempts[0].reason, /nouvel essai dans 1[12]\d s/);
    });

    it("pauses a provider whose key is refused (401)", async () => {
        mockFetch({ [HOSTS.gemini]: () => httpError(401), [HOSTS.groq]: answersBothSteps(openAiAnswer) });
        process.env.CONTEXT_DETECTOR_AI_PROVIDERS = "gemini";
        process.env.CONTEXT_DETECTOR_LOCAL_FALLBACK = "on";
        process.env.CONTEXT_DETECTOR_LOCAL_MODEL_PATH = fakeModelPath();

        const first = await claims();
        assert.match(first.body.generated_by.attempts[0].reason, /clé refusée \(HTTP 401\)/);
        const geminiCalls = callsTo(HOSTS.gemini).length;

        const second = await claims();

        assert.equal(callsTo(HOSTS.gemini).length, geminiCalls, "Gemini must not be called again");
        assert.equal(second.body.generated_by.attempts[0].outcome, "skipped");
        assert.equal(second.body.generated_by.id, "local");
    });
});
