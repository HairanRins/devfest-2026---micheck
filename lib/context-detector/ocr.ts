import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { AiProviderInfo, MediaOcrResult, OcrQuality } from "@/lib/context-detector/types";

// Local OCR (docs/adr-local-fallback.md, option I1): tesseract.js reads the text
// of a screenshot so it can be sent to /investigate. There is no remote image
// provider, so this is the only one and its output is always indicative.
// tesseract.js and the @tesseract.js-data/* packages are optional and loaded
// lazily; language data is read from node_modules, so no network is needed.

const PACKAGE_NAME = "tesseract.js";
const LANGUAGES = ["fra", "eng"];
const OCR_TIMEOUT_MS = 30 * 1000;
const MAX_TEXT_LENGTH = 20000; // same limit as /investigate
const DEFAULT_LANG_DIR = "local-models/tesseract";

// Read on each use (not at import) so the folder follows the configuration.
const getLangDir = (): string =>
    path.resolve(process.env.CONTEXT_DETECTOR_OCR_LANG_DIR?.trim() || DEFAULT_LANG_DIR);

class OcrUnavailableError extends Error {}

interface TesseractWorker {
    recognize(image: Buffer): Promise<{ data: { text?: string; confidence?: number } }>;
}
interface TesseractModule {
    createWorker(
        langs: string[],
        oem: number,
        options: { langPath: string; cachePath: string; gzip: boolean },
    ): Promise<TesseractWorker>;
}

export const OCR_PROVIDER: Omit<AiProviderInfo, "attempts"> = {
    id: "tesseract",
    label: "OCR local (tesseract.js)",
    model: `tesseract LSTM ${LANGUAGES.join("+")}`,
    kind: "local",
    indicative: true,
};

// Tesseract.js reads every language from one directory, while each language is
// published as its own npm package: copy both .traineddata.gz files side by side.
const prepareLanguageData = (langDir: string): void => {
    const require = createRequire(path.join(process.cwd(), "package.json"));
    mkdirSync(langDir, { recursive: true });

    for (const lang of LANGUAGES) {
        const target = path.join(langDir, `${lang}.traineddata.gz`);
        if (existsSync(target)) {
            continue;
        }
        let packageDir: string;
        try {
            packageDir = path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
        } catch {
            throw new OcrUnavailableError(
                `Données de langue @tesseract.js-data/${lang} non installées : lancez « npm run models:install ».`,
            );
        }
        const source = ["4.0.0_best_int", "4.0.0"]
            .map((dir) => path.join(packageDir, dir, `${lang}.traineddata.gz`))
            .find((candidate) => existsSync(candidate));
        if (!source) {
            throw new OcrUnavailableError(`Fichier ${lang}.traineddata.gz introuvable dans ${packageDir}.`);
        }
        copyFileSync(source, target);
    }
};

let workerPromise: Promise<TesseractWorker> | undefined;
let queue: Promise<unknown> = Promise.resolve();

const getWorker = (): Promise<TesseractWorker> => {
    workerPromise ??= (async () => {
        let module: TesseractModule;
        try {
            module = (await import(
                /* webpackIgnore: true */ /* turbopackIgnore: true */ PACKAGE_NAME
            )) as TesseractModule;
        } catch {
            throw new OcrUnavailableError(
                `Paquet ${PACKAGE_NAME} non installé : lancez « npm run models:install ».`,
            );
        }
        const langDir = getLangDir();
        prepareLanguageData(langDir);
        // OEM 1 = LSTM engine only.
        return module.createWorker(LANGUAGES, 1, {
            langPath: langDir,
            cachePath: langDir,
            gzip: true,
        });
    })();
    workerPromise.catch(() => {
        workerPromise = undefined;
    });
    return workerPromise;
};

const toQuality = (confidence: number | undefined): OcrQuality | null => {
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
        return null;
    }
    if (confidence >= 85) {
        return "high";
    }
    return confidence >= 60 ? "medium" : "low";
};

const cleanOcrText = (text: string): string =>
    text
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.replace(/[ \t]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, MAX_TEXT_LENGTH);

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
    Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`délai OCR dépassé (${ms / 1000} s)`)), ms),
        ),
    ]);

export const runOcr = (bytes: Uint8Array): Promise<MediaOcrResult> => {
    const task = async (): Promise<MediaOcrResult> => {
        const base = { languages: LANGUAGES, provider: { ...OCR_PROVIDER, attempts: [] } };
        try {
            const worker = await getWorker();
            const { data } = await withTimeout(worker.recognize(Buffer.from(bytes)), OCR_TIMEOUT_MS);
            const text = cleanOcrText(data.text ?? "");
            return {
                ...base,
                status: "ok",
                text,
                quality: text ? toQuality(data.confidence) : null,
            };
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.error("Context Detector OCR failed:", reason);
            return {
                ...base,
                status: error instanceof OcrUnavailableError ? "unavailable" : "failed",
                text: "",
                quality: null,
                reason,
            };
        }
    };

    // One recognition at a time on the shared worker.
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
};
