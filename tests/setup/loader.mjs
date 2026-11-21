// Node module hooks for the integration tests (node --test, no extra dependency).
// - Compiles project .ts files with the project's own TypeScript, which drops
//   type-only imports (Node's built-in type stripping cannot).
// - Resolves the "@/" alias from tsconfig.json and "next/server" (no exports map).
// - Replaces the optional local-model packages with in-repo fakes, so the
//   fallback can be tested without downloading a 2 GB model.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FAKES = {
    "node-llama-cpp": path.join(ROOT, "tests/fixtures/fakes/node-llama-cpp.mjs"),
    "tesseract.js": path.join(ROOT, "tests/fixtures/fakes/tesseract.mjs"),
};
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts"];

export async function resolve(specifier, context, nextResolve) {
    if (FAKES[specifier]) {
        return { url: pathToFileURL(FAKES[specifier]).href, shortCircuit: true };
    }
    if (specifier === "next/server") {
        return nextResolve("next/server.js", context);
    }
    if (specifier.startsWith("@/")) {
        const base = path.join(ROOT, specifier.slice(2));
        const file = EXTENSIONS.map((ext) => base + ext).find(
            (candidate) => existsSync(candidate) && !candidate.endsWith(path.sep),
        );
        if (!file) {
            throw new Error(`Cannot resolve ${specifier} (looked in ${base}{${EXTENSIONS.join(",")}})`);
        }
        return { url: pathToFileURL(file).href, shortCircuit: true };
    }
    // Extension-less relative imports, as TypeScript allows ("../helpers").
    if (/^\.{1,2}\//.test(specifier) && context.parentURL?.startsWith("file:") && !path.extname(specifier)) {
        const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
        const file = EXTENSIONS.slice(1)
            .map((ext) => base + ext)
            .find((candidate) => existsSync(candidate));
        if (file) {
            return { url: pathToFileURL(file).href, shortCircuit: true };
        }
    }
    return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
    if (url.startsWith("file:") && /\.tsx?$/.test(url) && !url.includes("/node_modules/")) {
        const filename = fileURLToPath(url);
        const source = await readFile(filename, "utf8");
        const { outputText } = ts.transpileModule(source, {
            fileName: filename,
            compilerOptions: {
                module: ts.ModuleKind.ESNext,
                target: ts.ScriptTarget.ES2022,
                jsx: ts.JsxEmit.ReactJSX,
                esModuleInterop: true,
                sourceMap: false,
                inlineSourceMap: true,
            },
        });
        return { format: "module", source: outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
}
