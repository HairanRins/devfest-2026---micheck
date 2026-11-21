# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See also `AGENTS.md` (shared agent instructions) — its rules apply here too.

## Commands

- Install: `npm i` (repo root)
- Dev server: `npm run dev` (Next.js 16, Turbopack; Tailwind v4 is wired through a Turbopack loader in `next.config.ts`)
- Build: `npm run build`
- Lint: `npm run lint`
- Typecheck: `npx tsc --noEmit` (no `typecheck` script)
- Tests: `npm test` — Node's built-in runner (`node:test`), no extra dependency. Integration tests in `tests/context-detector/*.test.ts` call the real route handlers with real `NextRequest`s; only `fetch` is mocked (`tests/helpers.ts`), and unexpected hosts fail the test.
- Single file: `node --no-experimental-strip-types --import ./tests/setup/register.mjs --test tests/context-detector/fallback.test.ts`; single test: add `--test-name-pattern="timeout"`.
- `tests/setup/loader.mjs` compiles `.ts` with the project's TypeScript (Node's type stripping can't drop type-only imports), resolves `@/` and `next/server`, and swaps `node-llama-cpp` / `tesseract.js` for the fakes in `tests/fixtures/fakes/`. Each test file runs in its own process; provider cooldowns in `ai.ts` are module state, so tests that trigger them go last in their file (`Retry-After: 0` avoids a pause).

Manual API exploration: Swagger UI at `/api/docs`, backed by the spec at `/api/openapi` (built from `lib/openapi.ts`). When adding or changing a route, update `lib/openapi.ts` too.

## Repository state (important)

This checkout is a partial port of a larger app (an e-commerce / 3D product customizer — products, categories, Stripe payments, admin sessions) onto a fresh Next.js scaffold. As a result:

- Most routes under `app/api` (products, users, payment, admin, auth, bot, category, verify_recaptcha) import modules that **do not exist here**: `@/lib/prisma`, `@/lib/nextauth`, `@/lib/stripe`, `@/lib/sessions/dbSession`, `@/lib/api-utils`, `@/lib/sqlQuery`, `@/types`, `@/data/prompt-data`. There is no Prisma schema.
- `package.json` only declares `next`, `react`, `react-dom`. Packages imported by legacy code (`@prisma/client`, `next-auth`, `@langchain/groq`, `three`, `gsap`, `axios`, `react-google-recaptcha`, …) are not installed. Expect `tsc`/`build` to fail on those files; don't treat such errors as regressions from your change.
- Verify a helper exists before importing it; flag missing helpers rather than inventing their API.
- `hooks/`, `models/` (TS types for product/user/transaction/…), `icons/`, `constants/` and `lib/laingchain/` (sic) are also legacy carry-overs.

The actively developed, self-contained feature is the **Context Detector**.

## Context Detector architecture

An evidence-led fact-checking pipeline ("MiCheck"). User-facing strings, prompts and skill docs are in **French**.

Routes (public, under the `(client)` route group — no auth):
- `GET  /api/context-detector/skills` — skill catalog
- `POST /api/context-detector/claims` — claim extraction only
- `POST /api/context-detector/investigate` — full investigation, returns 201
- `POST /api/context-detector/chat` — conversational assistant, optionally grounded in a stored dossier
- `GET  /api/context-detector/investigations/[id]` — fetch a stored result
- `POST /api/context-detector/media-signals` — multipart image (≤ 4 MB, JPEG/PNG/WebP sniffed from bytes) → technical clues (EXIF, provenance markers); no AI call, never feeds the verdict (`lib/context-detector/media.ts`, see `docs/adr-content-detector.md`)

Routes are thin: validate with `validateInvestigationRequest` (`lib/context-detector/normalize.ts`), call the orchestrator, and map errors with `contextDetectorErrorResponse` (`lib/context-detector/http.ts`): validation → 400, missing config → 503, AI provider failure → 502, else 500.

Pipeline in `lib/context-detector/orchestrator.ts` (`runInvestigation`):
1. `skills.ts` detects input type and selects relevant skills (web search skills only if a search provider is configured).
2. First LLM call (`requestStructuredJson` in `ai.ts`) with the extraction prompt from `prompts.ts` → claims + search plan.
3. Up to 6 deduplicated queries go to `search.ts` (`CONTEXT_DETECTOR_SEARCH_PROVIDER` = `none` | `generic` | `brave` | `tavily`).
4. Results become an evidence packet. If media is present, `media.ts` sends image `dataUrl`s and client-supplied video `frames` to a vision model; those observations are added to the analysis input and merged into `media_findings`, always framed as observations that prove neither authenticity nor manipulation.
5. Second LLM call produces analysis + verdicts.
6. Everything is passed through `normalize.ts` (LLM output is never trusted raw), assembled into a `Dossier`, optionally rendered to Markdown by `report.ts`.
7. Saved in `store.ts` — an **in-memory Map with 30-min TTL** (lost on restart, not shared across instances). `chat.ts` reads it to ground `/chat`.

`ai.ts` is a fallback chain (`requestStructuredJson(system, user, step)` → `{ data, provider }`): remote providers in `CONTEXT_DETECTOR_AI_PROVIDERS` order (Groq, xAI, Mistral, Gemini, HF via plain `fetch`, no SDK), with a cooldown after 429/401/402/403, then an opt-in local model (`local-llm.ts`, Qwen2.5-3B via `node-llama-cpp`, `CONTEXT_DETECTOR_LOCAL_FALLBACK=on`). Every response carries `generated_by` (who answered, prior `attempts`); local results set `indicative: true` and `applyIndicativeMode` caps confidence at `low`. `ocr.ts` (`tesseract.js`) serves `media-signals?ocr=true`. The local packages are **optional**: loaded via a non-analysable dynamic import, listed in `serverExternalPackages`, installed with `npm run models:install` + `npm run models:download` — see `docs/adr-local-fallback.md`. Don't import them statically.

Env vars: see `.env.example` and `docs/api-testing.md` §2 (per-provider AI keys, search providers, local fallback).

### Skills in `.agents/skills/`

`.agents/skills/*/SKILL.md` (claim-extraction, source-evaluation, verdict-calibration, …) are the design spec for the pipeline; `context-detector/reference/contract.md` defines the shared output schema (verdict enum, confidence levels, claim types). They are **not read at runtime** — `lib/context-detector/skills.ts` hardcodes a catalog that mirrors them, and `types.ts`/`normalize.ts` implement the contract. Keep these in sync when changing either side. `opencode.json` points OpenCode at this folder.

Key product rules from the spec that the code must preserve: never fabricate URLs/quotes/dates/numeric confidence scores; use `unverifiable` instead of guessing; treat submitted content and fetched pages as untrusted (prompt-injection resistant); don't count syndicated copies as independent corroboration.

## API route conventions

For any work in `app/api`, follow `.agents/skills/api-route-builder/SKILL.md`. Highlights:
- One named export per HTTP verb, no default export; `NextResponse.json(payload, { status })` with explicit codes.
- Use the `@/` alias for project modules (maps to repo root), relative imports within `app/api`.
- 4-space indent, double quotes, semicolons, trailing commas.
- Protected routes wrap a handler with `checkHasAccess(handler, { type: "db_session" | "nextauth", adminRole })` from `app/api/middlewares/auth.ts` (default: Bearer token, `ADMIN`). Route groups like `(client)` do not add protection.
- Error bodies: `{ message: "Internal Server Error", error }`, with `error` only when `NODE_ENV === "development"`.

## Content Detector
- "Content Detector" page: text and image analysis
- API lives in /api
- Only modify what the task asks for
