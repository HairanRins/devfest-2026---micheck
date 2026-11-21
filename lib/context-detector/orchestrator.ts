import {
    ContextDetectorConfigurationError,
    isAiConfigured,
    requestStructuredJson,
} from "@/lib/context-detector/ai";
import {
    buildEvidencePacket,
    buildSources,
    normalizeAnalysis,
    normalizeClaimVerdicts,
    normalizeClaims,
    normalizeEvidence,
    normalizeOverallVerdict,
    normalizeSearchPlans,
} from "@/lib/context-detector/normalize";
import {
    buildAnalysisSystemPrompt,
    buildExtractionSystemPrompt,
    formatInputForPrompt,
} from "@/lib/context-detector/prompts";
import { renderDossierReport } from "@/lib/context-detector/report";
import { isSearchConfigured, searchWeb } from "@/lib/context-detector/search";
import { detectInputType, selectSkills } from "@/lib/context-detector/skills";
import { createInvestigationId, saveInvestigation } from "@/lib/context-detector/store";
import {
    ClaimsResponse,
    Dossier,
    InvestigationInput,
    InvestigationOptions,
    InvestigationRequest,
    InvestigationResponse,
} from "@/lib/context-detector/types";

const MAX_QUERIES = 6;

const textOf = (value: unknown, fallback = ""): string =>
    typeof value === "string" ? value : fallback;

const getDate = (options: InvestigationOptions): string =>
    options.investigationDate ?? new Date().toISOString();

const buildQueryList = (plans: ReturnType<typeof normalizeSearchPlans>, claims: Dossier["claims"]): string[] => {
    const queries = plans.flatMap((plan) => plan.queries);
    const fallbacks = claims.map((claim) => claim.verification_question || claim.claim_text);
    return Array.from(new Set([...queries, ...fallbacks].map((query) => query.trim()).filter(Boolean))).slice(
        0,
        MAX_QUERIES,
    );
};

const summarizeInput = (input: InvestigationInput): string => {
    if (input.text?.trim()) {
        const text = input.text.trim();
        return text.length > 180 ? `${text.slice(0, 177)}...` : text;
    }
    if (input.url?.trim()) {
        return `Page ou publication fournie : ${input.url}`;
    }
    const mediaTypes = (input.media ?? []).map((media) => media.type).join(", ");
    return `Médias soumis : ${mediaTypes || "non précisé"}`;
};

export const runClaimExtraction = async (
    request: InvestigationRequest,
): Promise<ClaimsResponse> => {
    if (!isAiConfigured()) {
        throw new ContextDetectorConfigurationError(
            "CONTEXT_DETECTOR_AI_API_KEY n'est pas configurée.",
        );
    }

    const input = request.content as InvestigationInput;
    const options = request.options ?? {};
    const skills = selectSkills(input, options);
    const investigationDate = getDate(options);

    const raw = await requestStructuredJson(
        buildExtractionSystemPrompt(skills, options.language),
        `${formatInputForPrompt(input)}\n\nDate de l'investigation : ${investigationDate}\nType d'entrée détecté : ${detectInputType(input)}`,
    );

    return {
        input_type: detectInputType(input),
        input_summary: textOf(raw.input_summary, summarizeInput(input)),
        language: textOf(raw.language, options.language ?? "auto"),
        investigation_date: investigationDate,
        claims: normalizeClaims(raw.claims),
    };
};

export const runInvestigation = async (
    request: InvestigationRequest,
): Promise<InvestigationResponse> => {
    if (!isAiConfigured()) {
        throw new ContextDetectorConfigurationError(
            "CONTEXT_DETECTOR_AI_API_KEY n'est pas configurée.",
        );
    }

    const input = request.content as InvestigationInput;
    const options = request.options ?? {};
    const investigationId = createInvestigationId();
    const investigationDate = getDate(options);
    const availableTools = isSearchConfigured() ? ["web_search"] : [];
    const skills = selectSkills(input, options, availableTools);
    const hasSkills = (id: string): boolean => skills.some((skill) => skill.id === id);

    const extraction = await requestStructuredJson(
        buildExtractionSystemPrompt(skills, options.language),
        `${formatInputForPrompt(input)}\n\nDate de l'investigation : ${investigationDate}\nType d'entrée détecté : ${detectInputType(input)}`,
    );

    const claims = normalizeClaims(extraction.claims);
    const searchPlan = normalizeSearchPlans(extraction.search_plan, claims);
    const queries = options.skipSearch ? [] : buildQueryList(searchPlan, claims);

    const searchOutcome = queries.length
        ? await searchWeb(queries)
        : {
              results: [],
              note: options.skipSearch
                  ? "Recherche web désactivée par l'appelant (skipSearch)."
                  : "Aucune requête de recherche disponible pour cette publication.",
          };

    const packet = buildEvidencePacket(searchOutcome.results, investigationDate);
    const mediaNeedsTools = (input.media ?? []).length > 0;
    const analysisUserMessage = [
        formatInputForPrompt(input),
        `Date de l'investigation : ${investigationDate}`,
        `Affirmations extraites :\n${JSON.stringify(claims)}`,
        `Paquet de preuves (seules sources autorisées) :\n${JSON.stringify(packet)}`,
        `Note sur la recherche : ${searchOutcome.note}`,
        mediaNeedsTools
            ? "Aucun outil OCR, d'extraction d'images clés ni de recherche d'image inversée n'est connecté : indique cette limite dans les conclusions sur les médias."
            : "",
    ]
        .filter(Boolean)
        .join("\n\n");

    const analysis = await requestStructuredJson(
        buildAnalysisSystemPrompt(skills, options.language),
        analysisUserMessage,
    );

    const evidence = normalizeEvidence(analysis.evidence, packet);
    const details = normalizeAnalysis(analysis, evidence);
    const claimVerdicts = normalizeClaimVerdicts(analysis.claim_verdicts, claims, evidence);
    const overallVerdict = normalizeOverallVerdict(analysis.overall_verdict, claimVerdicts, evidence);
    const sources = buildSources(packet, evidence, overallVerdict.key_evidence_ids);

    const limitations = [
        searchOutcome.note,
        ...(Array.isArray(analysis.limitations)
            ? analysis.limitations.filter((item): item is string => typeof item === "string")
            : []),
        ...(claims.length === 0 ? ["Aucune affirmation factuelle exploitable n'a été extraite."] : []),
        ...(mediaNeedsTools
            ? ["L'analyse binaire des médias (OCR, images clés, recherche inversée) n'a pas été effectuée."]
            : []),
        "La recherche n'est pas exhaustive ; une absence de résultat ne prouve pas la fausseté d'une affirmation.",
    ];

    const dossier: Dossier = {
        investigation_id: investigationId,
        input_summary: textOf(extraction.input_summary, summarizeInput(input)),
        input_type: detectInputType(input),
        language: textOf(extraction.language, options.language ?? "auto"),
        investigation_date: investigationDate,
        skills_used: skills.map((skill) => skill.id),
        claims,
        ...(hasSkills("investigation-planning") ? { search_plan: searchPlan } : {}),
        ...(hasSkills("web-evidence-search") ? { evidence } : {}),
        ...(hasSkills("source-evaluation") ? { source_assessments: details.source_assessments } : {}),
        ...(hasSkills("contradiction-analysis") ? { contradictions: details.contradictions } : {}),
        ...(hasSkills("context-timeline")
            ? { timeline: details.timeline, context_findings: details.context_findings }
            : {}),
        ...(hasSkills("image-investigation") ? { media_findings: details.media_findings } : {}),
        ...(hasSkills("video-investigation") ? { video_findings: details.video_findings } : {}),
        ...(hasSkills("quote-verification") ? { quote_findings: details.quote_findings } : {}),
        ...(hasSkills("manipulation-detection")
            ? { framing_findings: details.framing_findings }
            : {}),
        ...(hasSkills("evidence-gap-analysis") ? { evidence_gaps: details.evidence_gaps } : {}),
        claim_verdicts: claimVerdicts,
        overall_verdict: overallVerdict,
        sources,
        practical_takeaway: textOf(analysis.practical_takeaway),
        limitations,
    };

    const response: InvestigationResponse = {
        investigation_id: investigationId,
        dossier,
        ...(options.includeReport === false ? {} : { report: renderDossierReport(dossier) }),
    };

    saveInvestigation(response);
    return response;
};
