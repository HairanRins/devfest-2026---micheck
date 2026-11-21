# ADR-002: Free local fallback with npm models

- **Status:** accepted. Implemented on 2026-11-21; **not yet run with the real model** (see §5).
- **Date:** 2026-11-21
- **Inputs:** `PRODUCT_SCOPE.md`, `docs/adr-content-detector.md` (ADR-001), `lib/context-detector/ai.ts`

## 1. Context

`/claims` and `/investigate` depend on remote AI providers. `ai.ts` already tries Groq, xAI, Mistral, Gemini and Hugging Face in turn. When every provider is rate-limited or down, the pipeline returns 502, and a demo stops. We want a free last resort that runs on the machine itself and is installed via npm. Its results must be clearly marked as less reliable.

Constraints from `PRODUCT_SCOPE.md`:
- §6: under 1 minute per scenario; reproducible by a judge in 5 minutes; no invented URL or date.
- §7: no promise of deepfake detection; produce a verification dossier, not a true/false oracle.
- P2: OCR, a deepfake detector and similar features are out of scope for the 24 h.

## 2. Options considered

| | Option | Size | Expected accuracy (MMLU, approx.) | Valid JSON every time | `/investigate` on CPU |
|---|---|---|---|---|---|
| **T1 ✅** | `node-llama-cpp` + **Qwen2.5-3B-Instruct** Q4_K_M | ~2.0 GB, ~3 GB RAM | ~65 | Yes (output forced to a JSON schema) | ~3–6 min |
| T1b | same library + Qwen2.5-1.5B | ~1.0 GB, ~1.8 GB RAM | ~60 | Yes | ~1.5–3 min |
| T2 | `@huggingface/transformers` + Qwen2.5-0.5B | ~0.5 GB | ~47 | No | ~1–2 min, often failing |

| | Option for images | Size | Fit |
|---|---|---|---|
| **I1 ✅** | `tesseract.js` OCR, French and English | ~5 MB + ~2–15 MB per language | Text of screenshots, sent on to `/investigate`. Goes against P2, by an explicit choice. |
| I2 | Florence-2-base (Transformers.js) | ~250–350 MB | English descriptions only |
| I3 | CLIP zero-shot (Transformers.js) | ~90–150 MB | Coarse image type only |
| ✗ | AI-image or deepfake classifiers | — | Rejected: unreliable on real-world images, and contradicts §7 and P2 |

## 3. Decision

1. **Text: T1.** The local model is the **last** step, after every remote provider. It is **off by default**: `CONTEXT_DETECTOR_LOCAL_FALLBACK=on` turns it on.
2. **Images: I1, local only.** There is no remote image provider. OCR runs only when requested (`ocr=true` on `/media-signals`).
3. **Every response says which provider answered:**
   - `/claims` returns `generated_by`.
   - `/investigate` returns `dossier.generated_by.extraction` and `dossier.generated_by.analysis`.
   - `/media-signals` returns `ocr.provider`.

   Each entry gives `id`, `label`, `model`, `kind` (`remote` or `local`), `indicative`, and the `attempts` that failed or were skipped before it.
4. **Local results are "indicative":**
   - `indicative: true`
   - every confidence level is lowered to `low`
   - the limitation "Résultat indicatif…" is added
   - the Markdown report gets a "⚠️ Résultat indicatif" banner

   The verdict label is kept. The safeguards in `normalize.ts` still apply: sources come only from search, and a verdict without evidence becomes `unverifiable`.
5. **Detecting limits:** HTTP 429 pauses that provider for its `Retry-After` time, 60 s by default and 10 min at most. A refused key (401/403) or exhausted credit (402) pauses it for 5 min. While paused, the provider is skipped without a call and recorded as `skipped` in `attempts`.
6. **No change to startup time:** the npm packages and the model are loaded only on first use, from a module name the bundler can't follow, so they stay out of the bundle. `next.config.ts` lists them in `serverExternalPackages`.
7. **Optional install:** `npm run models:install` installs the packages, and `npm run models:download` downloads the 2 GB model into `models/` (ignored by git). Without them, the app works normally. The local provider then reports why it's unavailable, with the command to fix it.

## 4. Consequences

- **§6 under 1 minute:** the local text fallback won't meet it on CPU. That's why it's indicative and opt-in.
- **§6 5-minute setup:** unaffected, because the fallback is off by default and its packages are optional.
- **Deployment:** the local model works only on a self-hosted Node server, such as the demo laptop. It doesn't fit a serverless function like Vercel's.
- **Concurrency:** one generation at a time, through an internal queue. A second request waits for the first.
- **The local model writes fewer fields:** its schema is limited to the claims, the search plan, the evidence links, the verdicts and the takeaway. Timeline, contradictions and the other optional sections come back empty.
- **Memory:** the 3B model needs about 3 GB of RAM. The development machine used here has 5 GB in total, so check the demo machine. To use the 1.5B model instead, set `CONTEXT_DETECTOR_LOCAL_MODEL_PATH` to its file, with no code change.

## 5. Verification status

| Checked | How |
|---|---|
| ✅ Remote provider order, 429/401/5xx detection, cooldown without a call, `attempts`, 502/503 | Fake `fetch` |
| ✅ Local fallback marked indicative: confidence `low`, limitation, banner, provider named | Fake `node-llama-cpp` package |
| ✅ Model loaded only once, one context per request then released, per-step output schema, `temperature: 0`, timeout | Same fake |
| ✅ Model file or package missing: clear message with the right `npm run` command | Copy without packages |
| ✅ OCR: text cleaned, quality level, `fra+eng` data copied from npm, `ocr` flag checked, 200 + `unavailable` without the package | Fake `tesseract.js`, through the real route |
| ✅ Strict TypeScript, 0 errors | `tsc` 5.9.3 |
| ❌ **Real Qwen2.5-3B model and real `tesseract.js`** | Not possible here: the network ran at ~70 KB/s, `npm i` timed out twice, and the model alone would take ~8 h |

**To finish on a good connection:**
1. Run `npm run models:install`, then `npm run models:download`.
2. Set `CONTEXT_DETECTOR_LOCAL_FALLBACK=on` and leave every remote key empty, so only the local model is used.
3. Run the 3 demo scenarios, and record the duration and output quality.
4. Send a real screenshot to `/media-signals` with `ocr=true`.
