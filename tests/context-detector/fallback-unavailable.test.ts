// Integration test: the local fallback is on but cannot run (model file missing).
// Separate file, hence separate process: no model has been loaded yet.
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { afterEach, it, mock } from "node:test";
import { POST as postClaims } from "@/app/api/(client)/context-detector/claims/route";
import { GROQ_ONLY, HOSTS, httpError, jsonRequest, mockFetch, readJson, resetEnv, restoreFetch } from "../helpers";

afterEach(() => {
    restoreFetch();
    mock.restoreAll();
});

it("returns 502 with the download command when the primary fails and the local model file is missing", async () => {
    mock.method(console, "error", () => undefined);
    resetEnv({
        ...GROQ_ONLY,
        CONTEXT_DETECTOR_LOCAL_FALLBACK: "on",
        CONTEXT_DETECTOR_LOCAL_MODEL_PATH: path.join(os.tmpdir(), "micheck-missing-model.gguf"),
    });
    mockFetch({ [HOSTS.groq]: () => httpError(429, { "retry-after": "0" }) });

    const { status, body } = await readJson<{ message: string }>(
        await postClaims(jsonRequest("/api/context-detector/claims", { content: "Un texte à vérifier." })),
    );

    assert.equal(status, 502);
    assert.match(body.message, /groq: limite de requêtes atteinte \(HTTP 429\)/);
    assert.match(body.message, /local: Modèle local absent .*npm run models:download/);
    assert.equal((globalThis as { __fakeLlama?: { loads: number } }).__fakeLlama?.loads ?? 0, 0);
});
