# Backlog: MiCheck, prioritized by impact vs effort

- **Date:** 2026-11-21 (after commit `b95e971`)
- **Sources:**
  - `PRODUCT_SCOPE.md` (P0/P1/P2, §6 success criteria, §7 non-goals)
  - `docs/audit-api.md` (bug numbers)
  - `docs/adr-content-detector.md` (ADR-001)
  - `docs/adr-local-fallback.md` (ADR-002)
  - the code as it is now

**Scales**

- **Impact**, measured against the judging criteria in `PRODUCT_SCOPE.md` §6:
  - 🔴 Critical: blocks the demo or puts it at risk
  - 🟠 High: visible to the judges or required by §6
  - 🟡 Medium: quality or robustness
  - ⚪ Low: comfort or later
- **Effort:** XS < 1 h · S 1–3 h · M 3–6 h · L > 6 h

**Already done**, so not listed below:
- the anti-fabrication safeguards (audit bugs 4 and 5)
- Swagger with examples
- `/media-signals` (scope P1 #5)
- the provider cascade with local fallback (ADR-002)

## 1. Do now: high impact, low effort, or a blocker

| # | Feature | Impact | Effort | Source | Why |
|---|---|---|---|---|---|
| 1 | **Unblock `next build`**: move the 19 broken legacy shop routes out of `app/api`, or delete them | 🔴 | S | audit bug 1 | They import modules that don't exist, so the production build fails and the Context Detector can't be deployed at all. |
| 2 | **"Vérifier" page**: text box, image upload, chat-style bubbles, result card with coloured verdict, confidence, claims, citations, limitations, the "indicative" banner, and a visible note that deepfakes are not detected | 🔴 | M | P0 #1, §6 | Right now the product is a backend that nobody can use in 30 seconds, and the scope document calls this the main gap. |
| 3 | **Reproducible README and demo set**: `npm i` → `.env` → `npm run dev` in 5 minutes, the 3 scenarios from §5, 10 quick test cases | 🟠 | S | P0 #4, §6 | The README is still the create-next-app template, and §6 requires a judge to be able to reproduce the project in 5 minutes. |
| 4 | **Harden the `/investigate` and `/claims` input**: `options.language` restricted to short codes, `options.skills: []` refused, body ≤ 100 KB, `dataUrl` no longer accepted | 🟠 | XS | audit bugs 6, 13, 14 | `language` is inserted as-is into the system prompts (prompt injection), and the other three are a few lines each in `validateInvestigationRequest`. |
| 5 | **Existing fact-checks as evidence**: Google Fact Check Tools, queried with each claim, added to the evidence the AI receives, and quietly skipped without a key or results | 🟠 | S | P0 #2 | A published fact-check is the strongest and fastest evidence for a viral claim, and it reuses the evidence path that the anti-fabrication checks already protect. |
| 6 | **Overall timeout of about 45 s**: AI calls at 25 s, search at 8 s, a clear message when the limit is reached | 🟠 | S | audit bug 10, §6 | Today an investigation can take about 140 s, while §6 requires each scenario to run in under a minute. |
| 7 | **"Partager prudemment" button**: copies 3 lines (verdict, one citation, "À vérifier avant de partager") | 🟠 | XS | P0 #3 | It answers the hackathon brief ("verify before sharing") directly and costs almost nothing once item 2 exists. |
| 8 | **Visible steps**: "Affirmations → Recherche → Analyse → Dossier", using client-side state only | 🟡 | XS | P1 #6, ADR-001 §2.3 | It makes a 10–60 s wait feel like progress, without the server streaming that ADR-001 rejected. |

## 2. Do next: important before any public deployment

| # | Feature | Impact | Effort | Source | Why |
|---|---|---|---|---|---|
| 9 | **Rate limiting per IP and a daily AI cap**: 429 with `Retry-After`, using the limits set in ADR-001 §2.5 | 🟠 | S | audit bug 2, §8, ADR-001 | The paid AI routes are public with no limit, and a script could use up the free AI quota before the demo. |
| 10 | **Test the real local model and measure tokens**: `models:install` + `models:download`, the 3 scenarios using only the local model, a real OCR screenshot, tokens counted per investigation | 🟡 | S | ADR-002 §5, ADR-001 follow-up 5 | The local adapters have only been tested with stand-ins, and the daily AI cap in item 9 must be based on real token counts. |
| 11 | **Media block in the UI**: shows the `/media-signals` signals as clues and lets the user send the OCR text to `/investigate` | 🟡 | S | P1 #5, ADR-001/002 | It makes the image demo scenario (§5 #3) honest and readable, using endpoints that already exist. |
| 12 | **Unit tests** for `normalize.ts`, `media.ts`, `ai.ts` and `ocr.ts`, using the scenarios already tested by hand | 🟡 | S | audit missing feature 11 | These files hold every safeguard against bad AI output, and the scripts used so far only exist in a temporary folder. |
| 13 | **Fix reCAPTCHA and require it on `/investigate`** | 🟡 | S | §8, audit bug 15 | The scope document asks for it for a public deployment, but `/api/verify_recaptcha` is broken (`axios` missing, token not encoded). |
| 14 | **Smaller pipeline fixes**: duplicate claim IDs, unchecked `claim_ids`, the overall-verdict fallback, quote detection, Markdown escaping in the report, the declared `type` overriding the detected one | 🟡 | S | audit bugs 18–23 | Each one is small but can attach a verdict to the wrong claim or break a citation link in the report. |

## 3. Later: improves quality but costs time or adds latency

| # | Feature | Impact | Effort | Source | Why |
|---|---|---|---|---|---|
| 15 | **Read the top search results**: download and extract the 3–5 best pages | 🟡 | M | audit missing feature 2 | Verdicts currently rest on search snippets only, but this adds several seconds per investigation, which conflicts with item 6. |
| 16 | **Fetch the submitted URL**: main text, title, date, author | 🟡 | M | audit missing feature 1 | The `url` input type is only nominal today, because the page is never opened. |
| 17 | **Verdict feedback**: "Ce verdict vous aide-t-il ?", kept in memory or logged | ⚪ | XS | P1 #7 | Useful for tuning the prompts after the demo, but invisible to the judges. |
| 18 | **Persistent storage of investigations**: database instead of the 30-minute in-memory store | ⚪ | M | audit missing feature 5, §8 | The scope document says in-memory storage is enough for the demo, and shareable links can wait. |
| 19 | **Optional Telegram webhook** | ⚪ | M | P1 #8, §7 | It only shows a channel, and §7 explicitly says an external bot must not be required for the demo. |
| 20 | **Housekeeping**: clean up the PowerShell wrapper in `.gitignore`, mark the fixed bugs in `docs/audit-api.md` | ⚪ | XS | audit, step 5 | Prevents misleading the next person to work on the repo, with no effect on the product. |

## 4. Won't do (out of scope)

These are excluded by the scope document (P2, §7) or by the decisions already made:
- training or using a deepfake or AI-image detector
- reverse image search
- extracting keyframes from videos with ffmpeg
- user accounts
- a browser extension
- in-depth multilingual support
- fixing the legacy shop routes (payments, products, admin)
- a numeric confidence score

## Suggested order for the remaining time

Following the planning in `PRODUCT_SCOPE.md` §4:
- **First:** 1 → 4 → 6, the blockers and robustness fixes, about 3–4 h.
- **Core of the demo:** 2 + 7 + 8, the UI, about 5–6 h.
- **Then:** 5 → 11 → 3, about 4–5 h.
- **Before any public URL:** 9 and 10.
