# VALIDATION-08: Sonic Fingerprint Analysis — does this unit sound like the good ones?

**Author:** Alejandro Valdez (via Claude Code)  **Date:** 2026-09-30  **Status:** Draft
**Priority:** P1. Recordings are already being stored against units, but nothing reads them. Section-by-section acceptance is the first objective check we have for "this SPU sounds wrong."
**Target branch:** `feat/sonic-fingerprint-analysis` (off `master`)
**Related:** VALIDATION-05 (validation runs), VALIDATION-07 (thermocouple file ingestion: parse on the server, the stored file is the record), the standalone prototype `C:\Users\aleja\spu-audio\spu_audio.py` + `docs/PRD-SPU-AUDIO-01.md`.

> File paths and line numbers below were verified against `origin/master` @ `3fcbddfcd` on 2026-09-30.

---

## 1. Problem Statement

`/validation/sonic` stores a phone recording of a unit running the motion-only assay. It uploads the file to R2, creates a `ValidationSession {type:'sonic'}` and journals it on the SPU. Then nothing happens: `processedData: null`, `passed: null`, and the page says "waveform analysis comes once we have a few to compare." We now have recordings of 7 units (217, 226, 229, 237, 245, 248, 250). The prototype showed the recordings contain real, per-unit differences:

- **SPU 248** has a +15 dB hump at 4–8 kHz in every section.
- **SPU 245's** dominant tone is 1.37 kHz in P1, where every other unit sits at 290–580 Hz.
- **All 7 units** share the same loudness *timing* within ±1.4 dB per phase.

Today an engineer can only find this by downloading files and running a Python script on a laptop. BIMS should do it where the recording already lives.

## 2. Goals

1. **Analyze on the server.** Every sonic recording (m4a/AAC or WAV) is analyzed on the server into a stored **fingerprint**, with no laptop and no ffmpeg. It can be re-analyzed at any time from the stored file.
2. **Compare page.** Any set of recordings can be lined up in time and compared on one set of charts:
   - dominant frequency over time, with peaks and valleys labeled;
   - loudness over time, with the loudest and quietest unit labeled per phase;
   - per-phase grids;
   - a similarity table;
   - a section-by-section acceptance scorecard.
   
   Every chart uses a 10 s grid.
3. **Reference set.** Engineers mark known-good recordings as **reference**, per assay. Each new recording gets an **advisory** verdict: section-by-section, inside or outside the references' mean ± 2σ.
4. **The verdict is recorded where people look:** on the session (`passed`, `failureReasons`, `criteriaUsed`) and as a line in the SPU journal.

## 3. Non-Goals

- **No release gating.** Sonic stays `graded:false` in `VALIDATION_TESTS` (`src/lib/server/spu-validation-cycle.ts:108`). `VALIDATION_INSTRUMENTS` (`:17`) stays at three, and no `validation.sonic` rollup is added to the Spu. That's a later PRD once the reference set is trusted (§10).
- **No upload rework.** The direct-to-Worker upload and the ≤4.5 MB proxy path landed on master 2026-09-30 (`455cb2f02`) and are kept as-is.
- **No analysis on the client.** Following the VALIDATION-07 principle, the browser only renders what the server computed.
- **No automatic "which part is failing" diagnosis.**

## 4. Current State

### 4.1 Upload and session (keep)
`src/routes/validation/sonic/+page.server.ts` has three actions:
- `upload` (proxy, ≤ `PROXY_MAX_BYTES` 4.5 MB, `:31`);
- `presign` + `record` (direct PUT to the R2 Worker with an HMAC token, `$lib/server/sonic-direct.ts`, enabled by `SONIC_DIRECT_UPLOAD=1`).

All three end in `persistRecording` (`:113`), which writes:
```ts
results: [{ _id, testType: 'sonic',
  rawData: { r2Key, fileName, size, mimeType, notes, via },
  processedData: null, passed: null, ... }]
```
plus an AuditLog row `sonic_recording_upload` and `appendSpuJournal(... refLabel: 'Sonic fingerprint')`.

Downloads use the Worker (`recordingUrl` `:78` → `getR2Url`). The S3 credentials in the Vercel env are known-bad (comment `:52-54`), so **server-side reads must go through the Worker** (`downloadViaWorker`, `src/lib/server/services/r2.ts:212`), not `downloadFile` from `$lib/server/r2`.

### 4.2 Session model: room for analysis results with no migration
`src/lib/server/db/models/validation-session.ts`:
- `type: String` has no enum (`:6`).
- `results[].processedData: Mixed` (`:51`).
- Top-level `overallPassed` (`:37`), `failureReasons` (`:38`) and `criteriaUsed: Mixed` (`:39`) exist.
- There's no sacred or immutable middleware on this schema.

**Strict-mode trap:** any new *top-level* field must be declared, or it's silently dropped. Everything in this PRD therefore lives inside `results[0].rawData` / `results[0].processedData` (Mixed) or in the fields that already exist.

### 4.3 Verdict-after-upload precedent
`recordThermoVerdict` (`src/lib/server/validation/thermo-upload.ts:291`) updates `results.$.passed`, `overallPassed` and `failureReasons` with a positional `updateOne`, then writes an audit row. Sonic follows the same shape, but never touches `Spu.validation.*`.

### 4.4 Charts
Validation pages draw their own SVG, e.g. `src/lib/components/validation/thermocouple/ThermocoupleChart.svelte` and `src/routes/validation/magnetometer/sweep/SweepFieldChart.svelte`. `chart.js` is only used on the kanban pages, and `uplot` is not imported anywhere. Sonic follows the SVG house style.

### 4.5 Tests
Vitest 4: `npm run test:unit` → `tests/vitest.unit.config.ts`, node env, `src/**/*.test.ts`. Pure-math precedent: `src/lib/server/validation/optical-analysis.test.ts`.

## 5. Reference / Prior Art

The prototype `spu_audio.py` (numpy/scipy) is the spec for the math, and its constants carry over unchanged. It was validated on synthetic cases:
- identical copies → 0 flags;
- a copy shifted 3 s and raised 6 dB → offset recovered at +3.00 s, one level flag;
- an injected 3 kHz tone → flagged at +15 dB;
- in a 3-way comparison, only the altered unit is flagged.

On the 7 real recordings it produced a section scorecard of 237 10/11, 245 9/11, 250 9/11, 226 7/11, 229 6/11, 217 5/11 and 248 2/11. The TS port must reproduce these numbers (§11).

## 6. Data Model & Source

### 6.1 Assay on the recording (new, inside `rawData`)
`results[0].rawData.assay`: `'SONIC'` (assay A78C7989 "Sonic Fingerprint – Cortisol 5.6 Moves", 5 min) | `'BCODE'` | `'OTHER'`.
- Picked in the upload form. The default is `SONIC`, since the page instructs the SONIC- barcode.
- Older sessions have no value and are shown as "unknown". An engineer can set it later with the `setAssay` action.
- **Only recordings of the same assay are ever compared against a reference set.**

### 6.2 Fingerprint (new, `results[0].processedData`)
```ts
processedData: {
  analysis: {
    version: 1, analyzedAt, analyzedBy,
    durationS, sampleRate: 48000, decoder: 'aac' | 'wav',
    error?: string                        // set instead of fingerprint when decode fails
  },
  fingerprint: {                          // all numbers rounded (dB 0.1, Hz 1)
    envDb: number[],                      // 50 ms RMS envelope (dBFS) — alignment
    binS: 0.5,
    levelDb: number[],                    // per 0.5 s bin
    domHz: (number|null)[],               // dominant 100–2000 Hz, null when quiet
    active: 0|1[],                        // bin > quiet level + 6 dB
    bands: number[][],                    // [bin][21] 1/3-octave levels, 100 Hz–12.7 kHz
    psdDb: number[], psdHzStep: number,   // Welch average spectrum 0–16 kHz (~2.7k points)
    summary: { rmsDb, peakDbfs, noiseFloorDb, centroidHz, rolloffHz, flatness,
               bandLevels: number[5], tones: [hz, db][] },
    events: [start, end, peakDb, meanDb, domHz][]
  } | null,
  reference?: { on: boolean, by, at, note? },
  verdict?: {                             // stored when scored vs the reference set
    at, assay, referenceSessionIds: string[], sections: [name, a, b][],
    passedSections: number, totalSections: number,
    perSection: { name, loudInPct, toneInPct, pass }[]
  }
}
```
- **Size:** about 22k numbers, roughly 150 KB of JSON for a 5-min run, far below Mongo's 16 MB. The recent-recordings list excludes `processedData.fingerprint` from its load (`.select()`) so the list stays light.
- **Verdict on the session:** `results.$.passed` holds the verdict (true = every section passes). The top-level `overallPassed`, `failureReasons` (e.g. `"P3 107–130s: tone colour 52% inside"`) and `criteriaUsed { envelopeK, sigmaFloorDb, specSigmaFloorDb, passInsidePct, referenceSessionIds, assay, analysisVersion }` are written alongside.

## 7. Design / Architecture

### 7.1 Decode on the server with WASM (no ffmpeg)
- `@audio/decode-aac` (FAAD2 WASM, M4A/ADTS + ALAC) and `@audio/decode-wav`. Both are pure JS/WASM, run on Node 22, and have no native binary, so there's no Vercel bundling risk.
- Spike result, 2026-09-30, local Node: the 585 s `spu226 audio.m4a` decoded in 1.0 s at 309 MB RSS, and RMS −28.63 dBFS matches the Python/ffmpeg value (−28.6).
- **License:** `@audio/decode-aac` is GPL-2.0. It runs server-side only and is not distributed to customers (see §10 Q3).
- Stereo is averaged to mono. Anything that isn't 48 kHz is resampled to 48 kHz (polyphase, same as scipy `resample_poly`).
- Other formats (mp3/ogg/flac/caf/webm) are still stored, but analysis records `error: 'format not analyzable yet'`.

### 7.2 Where the math lives: `src/lib/server/sonic/` (pure TS, unit-tested)
| module | job |
|---|---|
| `fft.ts` | iterative radix-2 real FFT, Hann window, Welch PSD |
| `decode.ts` | Worker download → decoder by extension/magic → mono 48 kHz `Float32Array` |
| `features.ts` | `fingerprint(x)`: envelope, events, Welch spectrum, band levels, tonal peaks, 0.5 s bins (level, dominant Hz, 1/3-octave bands, active) |
| `compare.ts` | `compareFingerprints(fps, opts)`: alignment, common window, phases P#/B#, per-phase stats, peaks/valleys, similarity, section shapes, leave-one-out scoring |
| `analyze.ts` | load session → decode → fingerprint → `$set` → AuditLog → (if ≥ 3 refs) score and journal |
| `constants.ts` | the prototype's numbers, below |

Constants carried over from `spu_audio.py`:
- `FRAME_S=0.05`, `BIN_S=0.5`;
- `FREQ_LO/HI=100/2000`;
- `EVENT_RISE_DB=6`, `EVENT_SMOOTH_S=0.5`, `EVENT_GAP_S=1`, `EVENT_MIN_S=0.5`;
- `PHASE_MIN_S=3`, `SECTION_GAP_MIN_S=5`, `MAX_ALIGN_S=90`;
- `ENVELOPE_K=2`, `SIGMA_FLOOR_DB=1.0`, `SPEC_SIGMA_FLOOR_DB=1.5`, `PASS_INSIDE_PCT=90`;
- `LEVEL_SMOOTH_S=2`, `TICK_S=10`.

### 7.3 Compare math (from the prototype)
1. **Align.** Cross-correlate each recording's z-scored 50 ms envelope with the first recording's, limited to ±90 s. Then find the common window where every recording has audio.
2. **Phases.** P# are the stretches where the group is running (median of active bins across recordings, gaps under 1 s merged, at least 3 s long). B# are the gaps between phases that are at least 5 s long. Custom sections (`"110-130, 40-57"`) replace the automatic ones.
3. **Section shapes.**
   - *Loudness shape:* the 2 s-smoothed loudness with each recording's own section mean removed, so phone distance and room noise drop out.
   - *Tone colour:* the section's average 1/3-octave spectrum with its mean across bands removed.
4. **Scoring.** For each recording, the mean and σ come from **the other recordings** (compare page) or from **the reference set minus itself** (verdict). σ is floored. The score is the % of points within mean ± 2σ, and a section passes if both shapes are ≥ 90 %.
5. **Similarity.** Dominant-Hz difference, loudness difference and shape difference, averaged only over bins where both recordings are running. Peak/min loudness per recording comes from the 0.5 s bins.

### 7.4 When analysis runs
- The upload actions stay fast and unchanged. On success, the page calls a new `analyze` action for the new session. It has `maxDuration` 60; the decode plus fingerprint of a 5-min file takes about 2–4 s, so it runs synchronously in that request.
- A **Re-analyze** button per recording does the same, e.g. after `ANALYSIS_VERSION` bumps.
- If analysis fails, `processedData.analysis.error` is stored and shown as a red chip. It never blocks the recording from being the DHR record.

### 7.5 Verdict (advisory)
- **Needs ≥ 3 references** of the same assay, excluding the recording itself. With fewer, the verdict chip reads "insufficient reference (n/3)" and nothing is stored.
- **Stored after analyze** (auto) or on **Re-score** (manual). A stored verdict is history and is not rewritten when references change. The pages also show the **live** score against today's references.
- **Journal line** on the SPU: `Sonic: 10/11 sections pass vs 5 references (advisory)`, with `refKind:'validation_session'`.
- **Never touches** `Spu.validation.*` or the release-gate cycle.

### 7.6 Mutations and audit
Each of these actions requires `spu:write` and writes an AuditLog row (`tableName:'validation_sessions'`):

| action | audit action |
|---|---|
| `analyze` | `sonic_analysis` |
| `setReference` | `sonic_reference_set` / `_cleared` |
| `setAssay` | `sonic_assay_set` |
| `score` | `sonic_verdict` |

Loads require `spu:read`.

## 8. UX Spec (tron tokens, SVG charts, one colour per SPU across every chart)

### 8.1 `/validation/sonic` (extend the existing page)
- **Upload form:** add an **Assay** select (SONIC default / BCODE / Other). After a successful upload, show "Analyzing…" then the verdict chip.
- **Recordings list**, one row each:
  - checkbox (for compare), UDI link, file, assay badge;
  - analysis chip (✓ analyzed · ⏳ pending · ✗ error);
  - verdict chip (PASS 11/11 · CHECK 7/11 · "no reference");
  - ☆/★ reference toggle, audio player, **Details** link.
- **Toolbar:** "Compare selected (n)", an assay filter, "Analyze all pending".

### 8.2 `/validation/sonic/[sessionId]`: one recording
- **Header:** UDI, assay, date, who, audio player, summary numbers (duration, RMS, peak, noise floor, typical Hz).
- **Charts:**
  - loudness over time with the detected events shaded;
  - dominant Hz over time with peaks/valleys labeled;
  - 1/3-octave band-over-time heatmap ("spectrogram-lite");
  - average spectrum with the top tones labeled.
- **Verdict panel:** scorecard row vs the reference set, plus Re-score / Re-analyze / reference toggle / set-assay controls.

### 8.3 `/validation/sonic/compare?ids=a,b,c[&sections=110-130,40-57][&against=reference]`
This is the function built in the prototype. Sections, top to bottom:
1. **Section acceptance scorecard** (SPU × section, green PASS / amber / red CHECK, `loud% | tone%` in each cell), with passed-count per SPU.
2. **Envelope small-multiples:** loudness shape and tone colour, grey ±2σ band, thick line for any SPU outside it.
3. **Dominant frequency over time:**
   - all SPUs on one graph, 10 s grid, P#/B# labels;
   - with 2 SPUs, every running stretch's peak ▲ and valley ▼ is labeled;
   - with 3+, each phase labels its highest and lowest SPU;
   - labels are collision-stacked.
4. **Loudness over time:** all SPUs, 2 s average, per phase ▲ loudest / ▼ quietest SPU.
5. **Per-phase grids:** Hz, dBFS, and loudness *pattern* (offset removed).
6. **Similarity table:** typical Hz, average |Δf| (Hz, %), time within ±5 %, average |Δ loudness|, average shape difference, peak/min loudness and when.
7. **Controls:** sections input (Enter = automatic), "Judge against: each other / reference set" toggle, CSV download of the section scores and per-phase numbers.
8. **Guard:** a recording without a fingerprint is listed as "not analyzed" and left out of the comparison.

### 8.4 Components (`src/lib/components/validation/sonic/`)
- `TimeSeriesChart.svelte`: multi-series SVG with NaN gaps, 10 s grid, shaded phase bands with labels, ▲/▼ markers with collision-stacked labels, legend below the plot.
- `EnvelopeGrid.svelte`: small-multiples with the band.
- `PhaseGrid.svelte`: diverging heatmap table.
- `Scorecard.svelte`.
- `SpectrumChart.svelte`: log-frequency axis.

## 9. Stories

- **VALIDATION-08-S1 — Math core.** `fft.ts`, `features.ts`, `compare.ts`, `constants.ts` with unit tests. **AC:** `npm run test:unit` passes:
  - FFT of a 1 kHz sine peaks at 1 kHz ±1 bin;
  - a 3 s shift is recovered within ±0.05 s;
  - an injected 3 kHz tone is found;
  - identical copies pass every section;
  - leave-one-out flags only the altered unit of three.
- **S2 — Decode and analyze.** `decode.ts` + `analyze.ts` + `analyze` action. **AC:**
  - Analyzing a real m4a session stores a fingerprint with `analysis.version=1`, plus an AuditLog `sonic_analysis`.
  - A corrupt file stores `analysis.error` and nothing else changes.
- **S3 — Assay + reference.** Assay select on upload, `setAssay`, `setReference`. **AC:**
  - A new upload stores `rawData.assay`.
  - The ★ toggle persists `processedData.reference.on` and writes an audit row.
- **S4 — Verdict.** `score` + auto-score after analyze. **AC:**
  - With ≥ 3 SONIC references, analyzing a SONIC recording stores `processedData.verdict`, `results.$.passed`, `overallPassed`, `failureReasons` and `criteriaUsed`, and appends a journal line.
  - With fewer than 3 references, nothing is stored and the chip says "insufficient reference".
  - `Spu.validation` is unchanged.
- **S5 — Recordings list upgrades** (§8.1). **AC:** chips reflect state after an upload without a manual reload, and "Compare selected" opens the compare page with those ids.
- **S6 — Detail page** (§8.2). **AC:** every chart renders for a 5-min recording, and the audio plays.
- **S7 — Compare page** (§8.3). **AC:**
  - With the 7 prototype recordings, the scorecard matches the prototype within ±1 section per SPU.
  - Custom sections `110-130` produce one S1 column.
  - The CSV downloads.
- **S8 — Parity script** `scripts/sonic-parity.ts` (local, reads files from disk, no DB). **AC:** it prints the offsets, scorecard and peak/min table for the 7 files, next to the prototype's numbers.

## 10. Open Questions / Risks

**Risks**
- **R1: Phone and recorder variation dominates tone colour.** 229 (the only WAV, likely a different phone or app) fails mostly between phases. Mitigation: the upload help text asks for the same phone and a marked spot, and notes record the phone. The verdict stays advisory.
- **R2: Few references means a rough σ.** σ floors keep the band from collapsing. The page shows `n refs`, and the verdict says "insufficient" below 3.
- **R3: Function time.** A 10-min file decodes in about 1 s locally. Fingerprinting is dominated by roughly 2.8k 8192-point FFTs, which should take under 2 s. Budget is `maxDuration` 60, so there's headroom for a 30-min file.
- **R4: Compare-page payload.** Loading 7 fingerprints is about 1 MB. Compare runs in the load function and only chart-ready arrays go to the browser.

**Questions that need your decision**
- **Q1: Which assay is the standard?** The page instructs the 5-min SONIC assay (A78C7989), but the 7 existing recordings are BCODE runs. Reference sets are kept per assay either way. Which one should units be recorded on going forward?
- **Q2: Are the thresholds right?** ±2σ, 90 % of points inside, σ floors of 1.0 / 1.5 dB. These are the prototype's starting values; revisit after ~10 reference units.
- **Q3: Is GPL-2.0 acceptable for a server-only dependency?** (`@audio/decode-aac`, FAAD2.) If not, the fallback is decoding in the browser with Web Audio and uploading a WAV "analysis copy" beside the original.
- **Q4: When does sonic become graded?** Proposed: once a SONIC reference set of at least 8 units exists and a month of advisory verdicts shows no false CHECKs on known-good units. That's a follow-up PRD that flips `graded:true` and adds the `Spu.validation.sonic` rollup.

## 11. Test / Validation Plan

1. `npm run test:unit`: the S1 cases.
2. `npm run check`: zero new errors in touched files. Local `npm run build` OOMs on this machine, so the Vercel branch build is the build gate.
3. **Parity:** run `npx tsx scripts/sonic-parity.ts C:\Users\aleja\spu-audio\recordings\{229,226,217,237,245,248,250}` and compare with `spu_audio.py`:
   - offsets (226 +16.95 s, others within ±3 s);
   - 11 automatic sections;
   - passed-sections per SPU within ±1;
   - peak/min loudness within 0.5 dB.
4. **Vercel preview:**
   - upload an m4a over 4.5 MB (direct path);
   - the analysis chip turns ✓;
   - mark 3 references and upload a 4th → verdict chip and journal line appear;
   - the compare page for 7 recordings renders all sections;
   - the SPU's release-gate rollup is unchanged.

## 12. Out of Scope
- Grading and release gating (Q4), and a `validation.sonic` Spu rollup.
- A sonic step on the validation runs board (VALIDATION-05). It can link here later.
- Automatic phone/mic calibration, and noise cancellation.
- Fault classification ("fan", "rail", "stepper").

## Appendix A — File change map
**Add**
- `src/lib/server/sonic/{constants,fft,decode,features,compare,analyze}.ts` + `fft.test.ts`, `features.test.ts`, `compare.test.ts`
- `src/routes/validation/sonic/[sessionId]/+page.server.ts`, `+page.svelte`
- `src/routes/validation/sonic/compare/+page.server.ts`, `+page.svelte`
- `src/lib/components/validation/sonic/{TimeSeriesChart,EnvelopeGrid,PhaseGrid,Scorecard,SpectrumChart}.svelte`
- `scripts/sonic-parity.ts`
- `docs/prds/VALIDATION-08-sonic-fingerprint-analysis.md`

**Modify**
- `src/routes/validation/sonic/+page.server.ts`: assay on upload; `analyze` / `setReference` / `setAssay` / `score` actions; list load gains analysis/verdict/reference/assay and excludes the fingerprint.
- `src/routes/validation/sonic/+page.svelte`: assay select, post-upload analyze call, list chips, reference toggle, compare selection.
- `package.json` / lock: `@audio/decode-aac`, `@audio/decode-wav`.
- `progress.txt`

**Unchanged on purpose:** `spu-validation-cycle.ts`, `models/spu.ts`, `models/validation-session.ts`, `sonic-direct.ts`.

## Appendix B — Reference pointers
- Prototype: `C:\Users\aleja\spu-audio\spu_audio.py`, `selftest.py`, `docs/PRD-SPU-AUDIO-01.md`; 7-unit report `reports/2026-09-30_141703_compare/`.
- Upload paths: `src/routes/validation/sonic/+page.server.ts:113` (`persistRecording`), `src/lib/server/sonic-direct.ts`.
- Worker I/O: `src/lib/server/services/r2.ts:96` (`getR2Url`), `:212` (`downloadViaWorker`).
- Verdict precedent: `src/lib/server/validation/thermo-upload.ts:291`.
- Test registry: `src/lib/server/spu-validation-cycle.ts:103-110`.
- Session model: `src/lib/server/db/models/validation-session.ts:37-51`.
