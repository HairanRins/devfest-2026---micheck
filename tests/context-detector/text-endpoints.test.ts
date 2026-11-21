// Integration tests: /claims, /investigate, /investigations/{id}, /skills.
// The real route handlers run end to end; only the network (AI and search
// providers) is simulated. Scenarios follow PRODUCT_SCOPE.md §5 and §6.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { POST as postClaims } from "@/app/api/(client)/context-detector/claims/route";
import { POST as postInvestigate } from "@/app/api/(client)/context-detector/investigate/route";
import { GET as getInvestigation } from "@/app/api/(client)/context-detector/investigations/[id]/route";
import { GET as getSkills } from "@/app/api/(client)/context-detector/skills/route";
import type {
    ClaimsResponse,
    InvestigationResponse,
} from "@/lib/context-detector/types";
import {
    answersBothSteps,
    callsTo,
    EXTRACTION,
    getRequest,
    GROQ_ONLY,
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

const SCENARIO_1 = {
    content: {
        type: "text",
        text: "URGENT : à partir de demain, une nouvelle loi interdit de payer en espèces au-delà de 10 € dans tous les commerces en France.",
    },
    options: { language: "fr" },
};

const investigate = async (body: unknown) => {
    const response = await postInvestigate(jsonRequest("/api/context-detector/investigate", body));
    return readJson<InvestigationResponse & { message?: string }>(response);
};

const extractClaims = async (body: unknown) => {
    const response = await postClaims(jsonRequest("/api/context-detector/claims", body));
    return readJson<ClaimsResponse & { message?: string }>(response);
};

beforeEach(() => {
    resetEnv({ ...GROQ_ONLY, ...WITH_TAVILY });
    mock.method(console, "error", () => undefined); // routes log expected failures
    mockFetch({ [HOSTS.groq]: answersBothSteps(openAiAnswer), [HOSTS.tavily]: tavilyAnswer });
});

afterEach(() => {
    restoreFetch();
    mock.restoreAll();
});

describe("GET /api/context-detector/skills", () => {
    it("lists the skill catalog without any key", async () => {
        resetEnv();
        const { status, body } = await readJson<{ count: number; skills: { id: string }[] }>(
            await getSkills(),
        );
        assert.equal(status, 200);
        assert.equal(body.count, body.skills.length);
        assert.ok(body.skills.some((skill) => skill.id === "claim-extraction"));
    });
});

describe("POST /api/context-detector/claims — valid input", () => {
    it("extracts claims and says which provider answered", async () => {
        const { status, body } = await extractClaims(SCENARIO_1);

        assert.equal(status, 200);
        assert.equal(body.input_type, "text");
        assert.equal(body.claims[0].id, "C1");
        assert.equal(body.claims[0].claim_type, "policy_legal");
        assert.equal(body.generated_by.id, "groq");
        assert.equal(body.generated_by.kind, "remote");
        assert.equal(body.indicative, false);
        assert.deepEqual(body.generated_by.attempts, []);
    });

    it("accepts content as a plain string", async () => {
        const { status, body } = await extractClaims({ content: "La tour Eiffel mesure 330 mètres." });
        assert.equal(status, 200);
        assert.equal(body.input_type, "text");
    });

    it("makes one AI call in JSON mode and no web search", async () => {
        await extractClaims(SCENARIO_1);
        const [call] = callsTo(HOSTS.groq);
        assert.equal(callsTo(HOSTS.groq).length, 1);
        assert.deepEqual(call.body.response_format, { type: "json_object" });
        assert.equal(callsTo(HOSTS.tavily).length, 0);
    });
});

describe("POST /api/context-detector/investigate — valid input", () => {
    it("returns a dossier, a report and the provider for each step (201)", async () => {
        const { status, body } = await investigate(SCENARIO_1);

        assert.equal(status, 201);
        assert.match(body.investigation_id, /^[0-9a-f-]{36}$/);
        assert.equal(body.dossier.claim_verdicts[0].verdict, "refuted");
        assert.equal(body.dossier.generated_by.extraction.id, "groq");
        assert.equal(body.dossier.generated_by.analysis.id, "groq");
        assert.equal(body.dossier.indicative, false);
        assert.match(body.report ?? "", /Réfuté — dossier de vérification/);
        assert.doesNotMatch(body.report ?? "", /Résultat indicatif/);
    });

    it("never returns a URL, excerpt or date invented by the model (PRODUCT_SCOPE §6)", async () => {
        const { body } = await investigate(SCENARIO_1);
        const [evidence] = body.dossier.evidence ?? [];

        assert.equal(evidence.url, SEARCH_RESULT.url);
        assert.equal(evidence.excerpt, SEARCH_RESULT.content);
        assert.equal(evidence.published_date, SEARCH_RESULT.published_date);
        assert.deepEqual(
            body.dossier.sources.map((source) => source.url),
            [SEARCH_RESULT.url],
        );
        assert.doesNotMatch(JSON.stringify(body), /invented\.example|CITATION INVENTÉE|2099-01-01/);
    });

    it("cites evidence for every verdict or says unverifiable (PRODUCT_SCOPE §6)", async () => {
        const { body } = await investigate(SCENARIO_1);
        for (const verdict of body.dossier.claim_verdicts) {
            assert.ok(
                ["unverifiable", "opinion_or_non_factual"].includes(verdict.verdict) ||
                    verdict.evidence_ids.length > 0,
                `${verdict.claim_id} has no evidence`,
            );
        }
    });

    it("downgrades a verdict to unverifiable when search is skipped", async () => {
        const { status, body } = await investigate({ ...SCENARIO_1, options: { skipSearch: true } });

        assert.equal(status, 201);
        assert.equal(callsTo(HOSTS.tavily).length, 0);
        assert.equal(body.dossier.claim_verdicts[0].verdict, "unverifiable");
        assert.equal(body.dossier.claim_verdicts[0].confidence, "low");
        assert.equal(body.dossier.overall_verdict.label, "unverifiable");
    });

    it("omits the Markdown report when includeReport is false", async () => {
        const { body } = await investigate({ ...SCENARIO_1, options: { includeReport: false } });
        assert.equal(body.report, undefined);
    });

    it("stores the dossier so GET /investigations/{id} returns it", async () => {
        const created = await investigate(SCENARIO_1);
        const id = created.body.investigation_id;

        const { status, body } = await readJson<InvestigationResponse>(
            await getInvestigation(getRequest(`/api/context-detector/investigations/${id}`), {
                params: Promise.resolve({ id }),
            }),
        );
        assert.equal(status, 200);
        assert.equal(body.investigation_id, id);
        assert.deepEqual(body.dossier.claims, created.body.dossier.claims);
    });
});

describe("Invalid input", () => {
    const cases: [string, unknown][] = [
        ["empty string content", { content: "   " }],
        ["missing content", { options: { language: "fr" } }],
        ["content object without text, url or media", { content: { type: "text" } }],
        ["text longer than 20,000 characters", { content: { text: "a".repeat(20001) } }],
        ["body that is not JSON", "this is not json"],
    ];

    for (const [name, body] of cases) {
        it(`/claims and /investigate return 400 for ${name}`, async () => {
            const claims = await extractClaims(body);
            const dossier = await investigate(body);

            assert.equal(claims.status, 400);
            assert.equal(dossier.status, 400);
            assert.equal(typeof claims.body.message, "string");
            assert.equal(callsTo(HOSTS.groq).length, 0, "no AI call for invalid input");
        });
    }

    it("GET /investigations/{id} returns 404 for an unknown id", async () => {
        const id = "00000000-0000-4000-8000-000000000000";
        const response = await getInvestigation(
            getRequest(`/api/context-detector/investigations/${id}`),
            { params: Promise.resolve({ id }) },
        );
        assert.equal(response.status, 404);
    });
});

describe("Configuration and provider errors", () => {
    it("returns 503 when no AI provider is configured", async () => {
        resetEnv();
        const { status, body } = await extractClaims(SCENARIO_1);
        assert.equal(status, 503);
        assert.match(body.message ?? "", /CONTEXT_DETECTOR_LOCAL_FALLBACK/);
    });

    it("returns 502 when the only provider fails", async () => {
        mockFetch({ [HOSTS.groq]: () => httpError(500) });
        const { status, body } = await investigate(SCENARIO_1);
        assert.equal(status, 502);
        assert.match(body.message ?? "", /groq: erreur du fournisseur \(HTTP 500\)/);
    });

    it("returns 502 when the provider answers without JSON", async () => {
        mockFetch({
            [HOSTS.groq]: () =>
                Response.json({ choices: [{ message: { content: "Désolé, je ne peux pas." } }] }),
        });
        const { status } = await extractClaims(SCENARIO_1);
        assert.equal(status, 502);
    });

    it("keeps the extracted claim shape when optional fields are missing", async () => {
        mockFetch({
            [HOSTS.groq]: () =>
                openAiAnswer({ claims: [{ claim_text: EXTRACTION.claims[0].claim_text }] }),
        });
        const { status, body } = await extractClaims(SCENARIO_1);
        assert.equal(status, 200);
        assert.equal(body.claims[0].id, "C1");
        assert.equal(body.claims[0].claim_type, "other");
        assert.equal(body.claims[0].checkability, "verifiable");
    });
});
