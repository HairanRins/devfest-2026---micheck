import { SearchResult } from "@/lib/context-detector/types";

type SearchProvider = "none" | "generic" | "brave" | "tavily";

export interface SearchOutcome {
    results: SearchResult[];
    note: string;
}

const DEFAULT_BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_TAVILY_URL = "https://api.tavily.com/search";
const MAX_RESULTS_PER_QUERY = 6;
const MAX_RESULTS = 12;

interface RawSearchResult {
    title?: unknown;
    url?: unknown;
    description?: unknown;
    snippet?: unknown;
    content?: unknown;
    publisher?: unknown;
    source?: unknown;
    published_date?: unknown;
    publishedDate?: unknown;
    page_age?: unknown;
}

export const getSearchProvider = (): SearchProvider => {
    const provider = process.env.CONTEXT_DETECTOR_SEARCH_PROVIDER?.trim().toLowerCase();
    if (provider === "generic" || provider === "brave" || provider === "tavily") {
        return provider;
    }
    return "none";
};

export const isSearchConfigured = (): boolean =>
    getSearchProvider() !== "none" &&
    Boolean(process.env.CONTEXT_DETECTOR_SEARCH_API_KEY?.trim());

const asText = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;

const normalizeResult = (
    raw: RawSearchResult,
    query: string,
): SearchResult | undefined => {
    const url = asText(raw.url);
    const title = asText(raw.title);
    if (!url || !title || !/^https?:\/\//i.test(url)) {
        return undefined;
    }

    return {
        url,
        title,
        publisher: asText(raw.publisher) ?? asText(raw.source),
        publishedDate:
            asText(raw.published_date) ??
            asText(raw.publishedDate) ??
            asText(raw.page_age),
        snippet:
            asText(raw.description) ??
            asText(raw.snippet) ??
            asText(raw.content) ??
            "",
        query,
    };
};

const fetchGeneric = async (query: string): Promise<RawSearchResult[]> => {
    const url = process.env.CONTEXT_DETECTOR_SEARCH_URL?.trim();
    if (!url) {
        throw new Error("CONTEXT_DETECTOR_SEARCH_URL manquante");
    }

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${process.env.CONTEXT_DETECTOR_SEARCH_API_KEY}`,
        },
        body: JSON.stringify({ q: query, count: MAX_RESULTS_PER_QUERY }),
        signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
        throw new Error(`Statut ${response.status}`);
    }

    const payload = (await response.json()) as {
        results?: RawSearchResult[];
    };
    return Array.isArray(payload.results) ? payload.results : [];
};

const fetchBrave = async (query: string): Promise<RawSearchResult[]> => {
    const baseUrl =
        process.env.CONTEXT_DETECTOR_SEARCH_URL?.trim() || DEFAULT_BRAVE_URL;
    const endpoint = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}${new URLSearchParams({
        q: query,
        count: String(MAX_RESULTS_PER_QUERY),
    })}`;

    const response = await fetch(endpoint, {
        headers: {
            accept: "application/json",
            "x-subscription-token": process.env.CONTEXT_DETECTOR_SEARCH_API_KEY ?? "",
        },
        signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
        throw new Error(`Statut ${response.status}`);
    }

    const payload = (await response.json()) as {
        web?: { results?: RawSearchResult[] };
    };
    return Array.isArray(payload.web?.results) ? payload.web.results : [];
};

const fetchTavily = async (query: string): Promise<RawSearchResult[]> => {
    const baseUrl =
        process.env.CONTEXT_DETECTOR_SEARCH_URL?.trim() || DEFAULT_TAVILY_URL;

    const response = await fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            api_key: process.env.CONTEXT_DETECTOR_SEARCH_API_KEY,
            query,
            max_results: MAX_RESULTS_PER_QUERY,
        }),
        signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
        throw new Error(`Statut ${response.status}`);
    }

    const payload = (await response.json()) as {
        results?: RawSearchResult[];
    };
    return Array.isArray(payload.results) ? payload.results : [];
};

const fetchResults = (provider: SearchProvider, query: string) => {
    if (provider === "brave") {
        return fetchBrave(query);
    }
    if (provider === "tavily") {
        return fetchTavily(query);
    }
    return fetchGeneric(query);
};

export const searchWeb = async (queries: string[]): Promise<SearchOutcome> => {
    const provider = getSearchProvider();
    if (!isSearchConfigured()) {
        return {
            results: [],
            note: "Recherche web indisponible : configurez CONTEXT_DETECTOR_SEARCH_PROVIDER et CONTEXT_DETECTOR_SEARCH_API_KEY pour vérifier sur Internet.",
        };
    }

    const uniqueQueries = Array.from(new Set(queries.map((query) => query.trim()).filter(Boolean)));
    if (uniqueQueries.length === 0) {
        return { results: [], note: "Aucune requête de recherche générée." };
    }

    const batches = await Promise.all(
        uniqueQueries.map(async (query) => {
            try {
                const rawResults = await fetchResults(provider, query);
                return rawResults.map((raw) => ({ query, raw }));
            } catch (error) {
                console.error("Context Detector search failed:", error);
                return [];
            }
        }),
    );

    const seen = new Set<string>();
    const results: SearchResult[] = [];
    batches.flat().forEach(({ query, raw }) => {
        const normalized = normalizeResult(raw, query);
        if (!normalized || seen.has(normalized.url)) {
            return;
        }
        seen.add(normalized.url);
        results.push(normalized);
    });

    return {
        results: results.slice(0, MAX_RESULTS),
        note:
            results.length === 0
                ? "La recherche web n'a renvoyé aucun résultat exploitable."
                : "Les résultats de recherche sont des pistes, pas des preuves ; seules les sources ouvertes et évaluées doivent étayer un verdict.",
    };
};
