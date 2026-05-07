# ERP Integration — Questions for the Finance-Experienced Stakeholder

**Audience:** A senior executive (CEO / COO / CFO / President) with long-standing business and finance experience, in conversation with a project owner who is engineering-trained.

**Why this exists:** The BIMS Financial Layer (a 10-phase ERPNext-inspired buildout) has 11 questions that need *business* answers, not engineering ones. Engineering can pick reasonable defaults, but a stakeholder with finance / accounting / strategy ownership has the right context to commit. Each question below explains: what we're asking, why it matters, what assumption engineering would default to, and what kind of answer is most common in companies of Bioscale's size and stage.

This doc is meant to make the conversation efficient — bring it printed, walk through one section at a time, get the answer in 30 seconds, move on. Total expected meeting time: 30-45 minutes.

---

## How to use this in the meeting

For each question, the goal is **a decision, not a discussion**. Try this script per item:

> "Quick one. We need to know X. Engineering's default would be Y. Most companies in our stage do Z. What's our answer?"

If the answer is "I don't know yet" — that's fine. Note "TBD, revisit by [date]" and move on. The questions blocking immediate Phase 1-3 work (marked **🔴 BLOCKING**) need real answers; the others can defer.

---

## 1. Is contract development a separate revenue stream from product sales? 🔴 BLOCKING (Phase 5)

**Plain English:** When we sell a cartridge to a customer, that's product revenue. But are there cases where a customer pays Bioscale to develop a new test for them (contract R&D, custom assay development, NRE)? If yes, that's a different revenue stream and gets its own GL accounts.

**Why it matters:** Two reasons. First, the chart of accounts has to have separate revenue lines so the income statement isn't muddled. Second, contract R&D gets revenue-recognized differently — usually milestone-based or percentage-of-completion, not point-of-sale. The accounting treatment is materially different.

**Default if unanswered:** One revenue line: `4100 Cartridge Sales`. Easy to refactor later by splitting into `4100 Cartridge Sales` + `4200 Contract Development Revenue`.

**Common pattern in diagnostics companies at Bioscale's stage:** Most pre-revenue or early-revenue diagnostic companies have *both* — they sell cartridges AND get NRE / development fees from pharma partners. Worth asking the executive directly: "Are we doing any work-for-hire today? Do we expect to in the next 12 months?"

---

## 2. R&D capitalization policy 🟡 IMPORTANT (Phase 1)

**Plain English:** When we spend money on R&D — engineer salaries, supplies for development assays, equipment used only in dev — does that count as an *expense* immediately (showing up in profit & loss), or as an *asset* on the balance sheet that gets amortized over time?

**Why it matters:** Affects every financial statement. Capitalization makes early P&L look better but creates an intangible asset that has to be amortized and tested for impairment annually. Most early-stage companies expense everything for simplicity. GAAP has specific rules (ASC 730) — generally R&D is expensed unless it meets specific software development criteria.

**Default if unanswered:** Expense everything. Simplest, GAAP-compliant for most R&D.

**Common pattern:** Pre-IPO companies almost always expense R&D. Capitalization is usually a CFO-driven decision tied to investor optics — should require the executive's explicit sign-off. The question really is: "Do we have an active capitalization policy, or do we just expense?"

---

## 3. Standard costing vs actual costing? 🔴 BLOCKING (Phase 3)

**Plain English:** When we produce a cartridge, what's its cost on the balance sheet? Two options:
- **Actual cost (FIFO):** every cartridge carries the actual cost of the materials and labor that went into it, in the order they were consumed (first-in, first-out).
- **Standard cost:** every cartridge gets a pre-set "standard" cost, and any difference between actual and standard becomes a variance recorded separately.

**Why it matters:** This is the foundational decision for inventory accounting. FIFO is more accurate but requires per-lot cost tracking. Standard costing is operationally simpler but requires periodic standard updates and variance analysis. ERPNext supports FIFO out of the box; standard costing is more complex to build.

**Default if unanswered:** **FIFO at the item level**, layered on per-lot SLE rows. Standard costing as a Phase 7+ option for cost-of-quality reporting.

**Common pattern:** Manufacturers under ~$50M revenue almost always use FIFO. Standard costing is more common in mature, high-volume manufacturers where cost stability is critical for pricing. **Likely answer here: FIFO** — and the executive should confirm.

---

## 4. Warranty terms and historical SPU failure rate 🟡 IMPORTANT (Phase 5)

**Plain English:** When we sell a cartridge or an SPU (the device), what's the warranty period? And what's our historical rate of devices coming back as defective? We need both to set up a "Warranty Reserve" — money set aside in advance for expected returns/replacements.

**Why it matters:** GAAP (ASC 460) requires accruing a warranty liability at the time of sale, even before any returns happen. The accrual rate comes from historical experience. If the company is too new for reliable history, an estimate is OK but documented.

**Default if unanswered:** No warranty reserve until 12 months of return data exists. Accrue 1-2% of revenue as placeholder until then.

**Common pattern:** Diagnostic device companies typically have 1-2-year warranties on hardware (SPUs), while consumables (cartridges) usually carry shorter warranties or "fit for purpose" replacement only. Failure rates of 0.5-2% are typical. **Ask: "What's our standard customer agreement say about warranty? And do we have any historical return data we can use as a starting point?"**

---

## 5. Customer pricing tiers / sales channel structure 🔴 BLOCKING (Phase 5)

**Plain English:** Do we sell cartridges at the same price to everyone, or are there tiers (e.g., research-use customers vs. clinical labs vs. distributors)? And do we sell direct to end users, or through distributors?

**Why it matters:** Affects revenue accounting. If we have distributors, the GL needs `4110 Direct Sales` vs `4120 Distributor Sales` (different gross margins, different sales-recognition timing). Volume discounts mean rebate accruals on the balance sheet. Different prices for different customers means a customer-tier field on the customer record.

**Default if unanswered:** Single price, single revenue account. Everyone is "direct."

**Common pattern in diagnostics:** Most companies have at least 2 tiers: list price for direct sales, distributor price (typically 30-40% off list). Some have a third tier for research-use customers (RUO). **Worth asking the executive: "Today, who do we sell to? Are all our prices public, or do we have a distributor agreement somewhere?"**

---

## 6. Sales tax nexus — what states / jurisdictions? 🔴 BLOCKING (Phase 5)

**Plain English:** "Nexus" means a state has the legal right to require us to collect sales tax on shipments to customers in that state. Nexus is established by physical presence (employees, offices, inventory) or — post-Wayfair (2018) — by economic activity (e.g., $100K of sales in a year, or 200 transactions). We need to know which states we have nexus in TODAY so the system collects sales tax correctly.

**Why it matters:** Mis-collecting sales tax is a real liability. If we should be collecting in California and aren't, the company owes back taxes plus interest plus penalties. The system needs to know per-state.

**Default if unanswered:** Bioscale's home state only (state of incorporation), no economic-nexus tracking. Manual tax handling for any other jurisdiction.

**Common pattern:** Most early-stage companies have nexus in 2-5 states (state of incorporation + remote employee states + maybe one or two heavy-customer states). Avalara or TaxJar is the standard solution at scale, but premature integration is wasted money. **Ask: "Where are our employees physically located? Are we registered with any state Departments of Revenue?"**

---

## 7. Accrual vs cash basis for tax filing 🟡 IMPORTANT (Phase 5)

**Plain English:** Two ways to recognize revenue and expenses for tax purposes. **Cash basis** = count it when money actually moves. **Accrual basis** = count it when you EARN the revenue (or INCUR the expense), regardless of when cash moves. The difference matters most for accounts receivable / accounts payable timing.

**Why it matters:** GAAP financial statements are always accrual; but the tax filing can be either, with restrictions. Companies above ~$25M average revenue MUST file on accrual. Below that, it's a choice with tax implications.

**Default if unanswered:** Accrual everywhere. GAAP is accrual; if Bioscale is on cash basis for tax, it's a one-time tax filing decision, not a system choice. The system always knows accrual.

**Common pattern:** Almost universally accrual for any company that's actively raising money or planning to. Worth a 30-second confirmation: "Are we on accrual basis with the IRS?"

---

## 8. Inter-company / multi-entity consolidation needed? 🟡 IMPORTANT (Phase 1)

**Plain English:** Is Bioscale a single legal entity, or are there multiple subsidiaries (e.g., a parent holding co + an operating co + an IP holding co)? If multiple, we need consolidated financial statements.

**Why it matters:** Multi-entity accounting requires: separate GL per entity, inter-company transaction tracking (transactions between sister companies), elimination entries at consolidation. ERPNext supports this via the "Company" field on every transaction. Engineering needs to know now whether to design for one company or many — retrofitting later is expensive.

**Default if unanswered:** Single-entity. One Company record at seed time. Still designed in a way that allows adding more later, but no inter-co accounting initially.

**Common pattern:** Most early-stage companies are single-entity. Multi-entity is usually triggered by international expansion (UK Ltd, EU GmbH) or IP holding for tax purposes (Delaware IP holdco). **Ask: "How many legal entities do we have today? Any plans for foreign subsidiaries?"**

---

## 9. Overhead / cost-allocation drivers — what to use? 🟡 IMPORTANT (Phase 6)

**Plain English:** Some costs (rent, utilities, depreciation, indirect labor) aren't directly tied to making one cartridge — they support the whole operation. To get "fully loaded" cost-per-cartridge, we have to allocate these across products. The question is: by what *driver*? Common choices: square footage of manufacturing space, headcount, machine hours, run count, batch count.

**Why it matters:** Affects cost-per-cartridge reporting, gross margin analysis, and pricing decisions. Different drivers will produce different "true" costs. Should be consistent and documented.

**Default if unanswered:** Direct costing only — no overhead allocation in v1. Gross margin reported on direct-cost basis. Add allocation in Phase 6+ when audit-ready costs are needed.

**Common pattern:** Early-stage companies use machine hours or batch count for manufacturing overhead. Later they get more sophisticated (Activity-Based Costing). **Ask: "Does our finance team allocate overhead today, and on what basis?"**

---

## 10. Quality-Hold accounting — auto-isolate or only on NCR? 🟡 IMPORTANT (Phase 7)

**Plain English:** When a cartridge fails QC, it gets put on "hold" pending disposition (use-as-is, rework, scrap). On the books, that means moving the cartridge from `1131 Finished Goods Inventory` to `1135 Quality-Hold Inventory` (sub-account, still an asset, just isolated). Question: do we always move it the moment QC flags it, or only when a formal Non-Conformance Report (NCR) is opened?

**Why it matters:** Affects how immediate the inventory accounting reflects quality issues. Auto-isolation is operationally cleaner but creates accounting noise (lots of small moves). NCR-gated is cleaner accounting but means short-window quality issues never hit the books.

**Default if unanswered:** NCR-gated only. Quality holds without an NCR are operational only, not accounting events.

**Common pattern in regulated companies:** ISO 13485 / 21 CFR 820 typically requires NCR for any disposition decision. So the NCR-gated approach aligns with compliance practice. **Likely answer: NCR-gated.** Worth confirming with the executive.

---

## 11. Multi-company support — yes or no at seed time? 🟡 IMPORTANT (Phase 1)

**Plain English:** Same as #8, but a phrasing for the engineering decision. Do we set up the system to support a single company (faster initial buildout) or multiple companies (more flexible later, slower now)? The schemas can support multi-company even if we only seed one — but we have to decide now.

**Why it matters:** Engineering needs to decide whether `Company` is a foreign key on every transaction or whether the whole system is implicit-single-tenant. Strongly recommended: add the field even if there's only one company today. Costs ~5% extra implementation effort.

**Default if unanswered:** Multi-company-capable schema, single-company seed. Best of both worlds.

**Common pattern:** Always design for multi-company even if only running one. Trivial to use; nontrivial to retrofit. **Likely answer: yes, multi-company schema, one seed company.**

---

## Bonus questions that usually come up

These aren't on the engineering blocking list but the executive may have opinions:

### A. Period close cadence — monthly, quarterly, annual?
The system supports all three; needs to know the cadence to enforce period-close locks. **Default:** monthly close, quarterly review, annual audit. Very standard for a company of Bioscale's stage.

### B. Approval thresholds — who can sign off on what dollar amount?
For purchase orders: who can approve $1,000? $10,000? $100,000? For journal entries: same question. Worth asking but defaults can be filled in later.

### C. Audit trail retention — how long do we keep financial records?
GAAP requires 7 years for tax records, 10 for ISO 13485. Default: forever (storage is cheap). No real choice to make here.

### D. External audit firm — engaged today, or planning to engage?
Affects how strictly we enforce GAAP. If engaged: very strict; some controls become non-negotiable. If not yet: simpler implementation, harder retrofit later.

### E. Banking integration — bank feed automation, or manual reconciliation?
Most early-stage companies use Plaid (or similar) for automated bank feeds via QuickBooks/NetSuite. If we're building from scratch, the question is whether we integrate now or do manual journal entries until volume justifies. **Default: manual until $1M+/month transactions.**

---

## What to do with the answers

1. **In the meeting:** check-mark each question with the answer (or "TBD by [date]" if defer).
2. **After the meeting:** I'll fold the decisions into the ERP master plan as committed defaults.
3. **For TBDs:** they become Phase-1 / Phase-3 / Phase-5 blockers per the column at the top. We can ship Phase 1-2 without resolving them; can't ship Phase 3+ without #3, #6, and #5 at minimum.

---

## A note on tone for the conversation

A finance-experienced executive will recognize most of this language immediately — terms like *nexus*, *FIFO*, *accrual*, *consolidation*, *capitalization* are part of their vocabulary. They may push back on questions that seem overly technical (#11 multi-company) by saying "just make the right call, that's a tech decision." That's fine — the engineering default is usually correct, and we just need their nod to proceed.

Where they'll have STRONG opinions (and we want them):
- **#1 contract revenue** — this is a strategic/business question
- **#3 FIFO vs standard** — affects how cost reports look
- **#4 warranty** — directly tied to customer agreements
- **#5 pricing tiers** — directly tied to commercial strategy
- **#6 sales tax nexus** — direct tax exposure

Get firm answers on those five at minimum. The rest can be "engineering's default is fine."
