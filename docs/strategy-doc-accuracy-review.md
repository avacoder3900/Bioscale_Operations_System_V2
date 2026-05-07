# Strategy Doc Accuracy Review — 2026-05-07

**Status:** Reviewed by background agent + reverified by main agent. **2 issues confirmed and fixed; 1 false-positive flagged below.**

## TL;DR

The 9 strategy docs are **production-ready for tomorrow's team discussion** after two small fixes that are now applied. One agent finding was a miscount (false positive) that we caught during verification.

---

## Summary of findings

| # | Doc | Claim | Reality | Action |
|---|---|---|---|---|
| 1 | `ask-bims-markdown-context.md` | "27 tools" | Actual: **27 tools** (verified) | ❌ Agent miscounted as 40. Doc is correct. No fix. |
| 2 | `erp-integration-master-plan.md` | "85 Mongoose models" | Actual: 86 | ✅ Fixed — updated to 86 |
| 3 | `process-analytics-enhancement-plan.md` | "14 core pure functions" | Actual: 12 | ✅ Fixed — updated to 12 |
| 4 | `bims-master-roadmap-2026.md` | "$0.01/q" cost claim | Detailed analysis says $0.006/q warm cache | 🟡 Both correct; cold-start is $0.01, warm cache is $0.006. Acceptable as-is. |

---

## Verification record

For finding #1 (the most prominent — 48% off would be a serious issue):

```
$ grep -cE "^\s*name: '" src/lib/server/ask-bims.ts
27
```

Confirmed: 27 tools, exactly as the doc claims. The reviewing agent miscounted; this is a **false positive** in the review report.

For finding #2:

```
$ ls src/lib/server/db/models/*.ts | wc -l
86
```

Confirmed: 86 models. The ERP doc said 85. Off by 1. Fixed.

For finding #3:

```
$ grep -cE "^export (async )?function " src/lib/server/analytics/stats.ts
12
```

Confirmed: 12 functions. The analytics doc said 14. Off by 2. Fixed.

---

## Cross-doc consistency

✅ Phase numbering consistent across master + workstream docs
✅ Cross-references resolve (file paths exist, sections referenced are real)
✅ Effort estimates align between master and workstream docs
✅ Dependency flow logical (Ask BIMS → high-value flows → compliance → ERP)

---

## Effort estimate sanity check (per agent)

| Workstream | Total effort | Phases | Verdict |
|---|---|---|---|
| Ask BIMS markdown | 2 weeks | 4 | Plausible |
| Scanner automation | 12 weeks | 7 | Plausible |
| Opentrons integration | 14 weeks | 7 | Plausible |
| QMS expansion | 12 weeks | 5 | Plausible |
| Process analytics | 16+ weeks | 5+ | Plausible |
| UI cleanup | 12 weeks | 5 | Plausible (tight for 159 pages) |
| ERP integration | 12-16 weeks | 10 | Plausible |

No estimates were grossly off (no 2-week claims for 4-month features).

---

## Final verdict

**Trustworthiness: HIGH.** The docs demonstrate thorough codebase knowledge, sound architectural reasoning, and careful effort scoping. After the 2 small fixes applied, they're stakeholder-ready.

**Lesson for future reviews:** Always verify counts via direct grep — even reviewing agents can miscount.

---

## Note on the false positive

The reviewing agent claimed 40 tools when the actual count is 27. This is a meaningful error: had we accepted it without verification, we would have edited a correct doc to make it incorrect. **General principle: when a review claims a count, verify with grep before applying the "fix."**
