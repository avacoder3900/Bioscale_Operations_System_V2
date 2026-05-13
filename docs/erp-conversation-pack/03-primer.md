# Conversation Primer — How to Think About Each ERP Stakeholder Question

**Audience:** You (engineering-trained project owner) before the conversation with the finance-experienced executive.

**Why this exists:** The questions in `erp-stakeholder-questions.md` use real finance/accounting terminology. This primer teaches you those terms in 1-2 sentences each so you can lead the conversation, push back if an answer doesn't make sense, and translate "executive-speak" back into engineering decisions afterward. Think of it as a cheat sheet, not a textbook.

**How to use it:** Read once before the meeting. Skim during it if a term comes up you forgot. Don't bring it to the meeting (looks like prep notes; you want to seem fluent).

---

## The big picture: what is "ERP" and why are we doing this?

ERP = Enterprise Resource Planning. In plain terms: the software system that runs the *money* side of a manufacturing company — what we bought, what we sold, what we owe, what we're owed, what our inventory is worth, what each unit costs to make. BIMS today is great at the *physical* side (cartridges, runs, equipment) but knows nothing about money. Adding an ERP layer means BIMS can answer questions like "how much does it cost us to make one cartridge today?" or "what's our gross margin per assay?"

Our approach: we're not buying SAP or NetSuite. We're building an ERP-shaped layer on top of BIMS using ERPNext (an open-source ERP) as our design reference — same data model, same accounting rules, but native to our stack. This is what the 13 erpnext-deep-dive docs are about.

The stakeholder conversation is to lock in the **business decisions** (not engineering decisions) we need to set this up correctly. Most of these decisions are one-time and very expensive to change later, so getting them right matters.

---

## The terms you need to know

### Chart of Accounts (COA)

The hierarchical list of every "bucket" the company tracks money in. A COA has top-level categories (Assets, Liabilities, Equity, Revenue, Expenses) that drill down into specific accounts (`1131 Finished Goods Inventory`, `4100 Cartridge Sales`, `5230 Wax Defect Scrap`).

**Engineer's intuition:** It's a tree of typed buckets. Every dollar that moves in the company goes from one bucket to another, and the COA is the schema for those buckets.

**Why it matters in the conversation:** Most questions are really "should we have a separate bucket for X, or just lump it in with Y?" — e.g., "Direct sales vs distributor sales" = one bucket or two.

---

### General Ledger (GL)

The transaction log of every entry to every account. When you sell a cartridge for $100, two entries are made: debit `1100 Cash` $100, credit `4100 Cartridge Sales` $100. Both entries hit the GL. Together they're called a "journal entry."

**Engineer's intuition:** GL = append-only event log. Every event has a debit row and a credit row that sum to zero. Total debits across all rows always equal total credits — that's how accounting works.

**Why it matters:** When the exec says "we need to see this on the GL" they mean "every transaction in this category should produce a debit/credit pair so it shows up in the financial statements."

---

### Stock Ledger Entry (SLE)

The ERP's transaction log specifically for *inventory* movements. Every time a cartridge moves between warehouses, gets consumed in a run, gets shipped — there's an SLE row capturing item, lot, qty, value.

**Engineer's intuition:** SLE is to inventory what GL is to money. Each SLE row generates corresponding GL rows (e.g., moving inventory between warehouses doesn't change total assets but moves dollars between sub-accounts).

---

### FIFO (First-In, First-Out) costing

When inventory is consumed, the cost assigned to that consumption is the cost of the OLDEST units first. If you bought 100 units at $5 last month and 100 units at $6 this month, when you sell 50, those 50 are valued at $5 each (the older inventory).

**Engineer's intuition:** Queue/FIFO data structure applied to inventory cost. Common alternative: **LIFO** (Last-In-First-Out — illegal under IFRS but allowed under US GAAP for tax). In modern manufacturing, FIFO is far more common.

**Other common method: Standard Costing.** Every unit gets a fixed pre-set cost, and any difference between actual and standard becomes a "variance" recorded separately. Operationally simpler but less accurate.

**Why it matters in our conversation:** This is one of the foundational decisions. The recommendation is FIFO because it's accurate and ERPNext supports it natively. Standard costing requires a costing module BIMS doesn't have.

---

### GAAP (Generally Accepted Accounting Principles)

The US accounting rulebook. Applies to financial statements that go to investors, banks, the IRS. Has specific rules for things like revenue recognition, inventory valuation, R&D expensing.

**Engineer's intuition:** Like IETF RFCs but for accounting. There's a body (FASB) that updates the rules; everyone follows. International equivalent is **IFRS**.

**Why it matters:** When your exec says "GAAP-compliant," they mean "follows the standard rules." When they say "ASC 730," they mean "the GAAP rule about R&D" (Accounting Standards Codification, section 730).

---

### Accrual basis vs Cash basis

Two ways to recognize revenue and expenses:
- **Cash:** Count it when money actually moves in/out of the bank.
- **Accrual:** Count it when you EARN the revenue or INCUR the expense, regardless of when the cash actually moves.

**Engineer's intuition:** Cash basis is like recording at point of payment; accrual is like recording at point of obligation. If you ship a cartridge today and the customer pays in 60 days: cash basis records it in 60 days; accrual records it today.

**Why it matters:** GAAP requires accrual. Tax filing can be cash basis below ~$25M revenue but most companies that plan to raise money use accrual everywhere.

---

### Revenue Recognition

The rules for WHEN you can count a sale as revenue. Simple case: cartridge sale → recognize when shipped (point of sale). Complicated case: contract development → maybe recognize at milestones (25% on signing, 50% at prototype, 25% on delivery), or by percentage-of-completion.

**Why it matters:** If we do contract R&D with pharma partners, we'd need separate revenue accounting and milestone tracking. Different rules under ASC 606 (the modern revenue recognition standard).

---

### R&D Capitalization

Two ways to treat R&D spending:
- **Expense it:** R&D costs hit the P&L immediately as an expense. Income looks lower today, but cleaner.
- **Capitalize it:** Treat R&D costs as an *asset* on the balance sheet (an "intangible asset"). Then amortize (gradually expense) over future years. Income looks higher today, but you carry an asset that needs annual impairment testing.

**Engineer's intuition:** Capitalization is like putting a one-time cost on a depreciation schedule instead of expensing it immediately.

**Why it matters:** Pre-IPO companies almost always expense everything. Capitalizing is mostly a CFO-driven decision tied to investor optics. ASC 730 says expense unless certain narrow criteria are met (mostly software).

---

### Warranty Reserve / Warranty Accrual

When you sell a product with a warranty, you have to assume some percentage will come back and need replacement/repair. GAAP (ASC 460) requires you to set aside a *liability* on the balance sheet at the moment of sale to cover that future expense.

**Engineer's intuition:** It's a precommitted "I owe this future obligation" entry. Like an insurance reserve.

**Why it matters:** Determining the rate (% of sales) requires either historical experience or industry estimate. If Bioscale doesn't have history yet, we estimate (1-2% is typical for diagnostic devices).

---

### Sales Tax Nexus

A state has "nexus" over your sales if it has the legal right to require you to collect sales tax from customers in that state. Three ways to establish nexus:
1. **Physical presence:** office, employee, inventory in that state
2. **Economic nexus** (post-Wayfair 2018): exceeding a sales/transaction threshold (typically $100K/yr or 200 transactions in a year)
3. **Marketplace nexus:** selling through a marketplace like Amazon

**Engineer's intuition:** Nexus = "the system needs to know we're collecting tax for this state." Each state has different rates, exempt categories, filing requirements.

**Why it matters:** Mis-collecting is a real liability. If Bioscale sells $200K of cartridges to California customers and doesn't collect CA sales tax, the state will eventually demand back-taxes plus interest plus penalties.

**Common solutions:** Avalara or TaxJar — third-party services that automatically calculate the right rate per state. Engineering recommendation is design for it but use manual templates until volume justifies the integration.

---

### Multi-Currency

Operating in more than one currency. If a French customer buys cartridges priced in EUR but our books are in USD, the system needs to track both. Plus exchange-rate fluctuations create gain/loss accounting (your $1M EUR receivable is worth different USD amounts day-to-day until paid).

**Engineer's intuition:** Currency-aware money fields. Adds `currency`, `exchangeRate`, `baseAmount`, `amount` to every monetary field.

**Why it matters:** Premature multi-currency support is wasted effort. Adding it later is a substantial refactor. Recommendation: design schemas with currency fields now (cheap), but don't enable until first foreign customer arrives.

---

### Multi-Entity / Multi-Company / Consolidation

Some companies have multiple legal entities — e.g., a parent company plus a subsidiary plus an IP holding company. Each entity has its own books. At quarter/year end, "consolidated" financial statements combine them while eliminating inter-entity transactions.

**Engineer's intuition:** It's a `companyId` foreign key on every transaction, plus rules for inter-company reconciliation.

**Why it matters:** Adding `companyId` everywhere now (and seeding one company) is cheap. Retrofitting later when we need a UK subsidiary is painful. Strongly recommended: design for multi-company even if running one.

---

### Cost Center

A "department" tag for cost tracking. When we spend money on lab supplies, we tag the expense with the cost center "Manufacturing-WaxFilling" so we can later report "how much did wax filling cost us this quarter."

**Engineer's intuition:** Cost centers are tags/categories on transactions. They live alongside accounts in the COA. Each transaction has both an account (what kind of money) and a cost center (which department).

**Why it matters:** Required for any P&L by department/process. ERP integration needs cost centers established early; engineering will want to pick a default cost center per warehouse so we don't have to ask operators every transaction.

---

### Period Close

End of the month/quarter/year, the books are "closed" — no new entries can be added to that period. New entries with that date have to either go to the next period or trigger a "reopen" workflow.

**Engineer's intuition:** Locking past time periods to be read-only.

**Why it matters:** Without period close, finance can't produce reliable monthly statements (someone would always be backdating entries). With it, the books are stable. Standard cadence: monthly close.

---

### Audit Trail

Immutable record of who did what when. Every change to financial data is logged forever — who edited a journal entry, who approved a purchase order, who closed a period. Required by GAAP and 21 CFR Part 11 (FDA's electronic records rule).

**Engineer's intuition:** BIMS already has `AuditLog` model. ERP layer extends it to financial events.

**Why it matters:** Non-negotiable for any company that wants external audit, IPO, or FDA compliance. The exec will assume this exists.

---

### Cost-of-Quality (CoQ) / Scrap Accounting

When manufacturing scraps a unit (defective cartridge), the dollars in that unit's inventory don't disappear — they get *moved* to a P&L expense account. CoQ is the financial term for tracking "money we lost to quality defects."

**Engineer's intuition:** Scrap = inventory write-down. The dollar value moves from `1131 Finished Goods` to `5230 Wax Defect Scrap` (or similar).

**Why it matters:** CoQ reporting is one of the highest-value outputs of the ERP integration. Lets us answer "how much did wax-fill rejection cost us this month?"

---

### Standard Cost vs Actual Cost (revisit)

Already covered above, but the deeper version:

**Actual cost (FIFO):** Each unit carries its real cost from the moment it was produced — material cost from the specific lots consumed, labor from the run, overhead allocation. Inventory value on the balance sheet is the sum of actual costs of unsold units.

**Standard cost:** A pre-determined "this is what one cartridge SHOULD cost" number. Each unit gets the standard. Differences from actual become variances reported separately (purchase price variance, labor variance, etc.).

**Trade-off:** Actual is more accurate but operationally heavier. Standard is operationally simple but requires periodic standard-cost updates and variance analysis. Companies under $50M revenue typically use FIFO. Standard costing is more common in mature, high-volume manufacturers (think large pharma).

---

### Inventory Valuation Methods

When selling, the cost matched against the revenue determines gross margin. Three methods:

- **FIFO:** Oldest units consumed first (most common, GAAP/IFRS approved)
- **LIFO:** Newest units consumed first (US GAAP only, rare in modern systems)
- **Weighted Average:** Pool cost / pool quantity = unit cost (smoother, simpler, also GAAP-approved)

**Why it matters:** This is one of the foundational decisions and is the most binding. ERPNext supports FIFO and Weighted Average. Recommendation: FIFO at item level.

---

### Subcontracting / Contract Manufacturing

When you send raw materials to a third party who does work and ships back finished goods. Important for Bioscale because some cartridge components might be cut/treated externally. Different accounting from a normal purchase: you're paying for *labor* on materials YOU still own.

**Engineer's intuition:** It's like a "checkout" of inventory to a vendor's warehouse, where they do work, and the result comes back into your inventory at a higher value.

**Why it matters:** ERPNext has a "subcontracting" workflow for this. Bioscale's `LaserCutBatch` is a candidate (if some cutting is done externally).

---

### NCR (Non-Conformance Report)

A formal QMS record that says "this batch / lot / cartridge / shipment didn't meet spec, here's the disposition decision." Required by ISO 13485 / 21 CFR 820 for any quality-related issue. Has its own state machine: open → investigation → containment → disposition (use-as-is / rework / scrap / return) → closed.

**Engineer's intuition:** It's a `NonConformance` model with statuses and links to the affected batch/lot/cartridge.

**Why it matters:** The QMS expansion plan introduces this. The ERP question about "Quality Hold accounting" is asking whether we move inventory to a quality-hold account on EVERY QC failure or only when an NCR is formally opened.

---

## How to lead the meeting

### Frame at the start

> "We're building a financial layer on BIMS. Engineering can pick reasonable defaults for everything, but for these eleven decisions, the default has business implications you should sign off on. I have the questions; each takes about 2 minutes. Want to start?"

That sets expectations: this isn't a deep dive, it's a decision-confirmation session.

### What to listen for

| Answer pattern | What it means |
|---|---|
| "Yeah we do that already, it's [specific term]" | Great — write it down literally and move on |
| "I don't know, ask [other person]" | Mark TBD with the owner; move on |
| "Why are you asking? Just make the call" | Confirm the engineering default verbally; "Sounds good, I'll go with [default]." Move on |
| Long deliberation | This is a real strategic question. Let them think. Take notes. Don't push. |
| "Wait, why is this a question?" | They're confused. Re-explain *why it matters*, not what it is |

### Pushback techniques (if you need them)

If the exec gives an answer that engineering can't easily implement, push gently:

- "That would mean [specific implementation cost]. We can do it, but it'd cost about [X weeks]. Worth it?"
- "Most companies our size don't do that until [trigger]. What's making us different?"
- "If we do that today vs in 6 months, the difference is [Y]. How urgent is it?"

If the exec is unsure between two options:

- "Default + we can refactor if needed" beats "Get it perfect now"
- "Schema-first / enforce later" is a common engineering pattern that buys both

### Don't let the meeting drift into

- **Implementation details** ("how exactly will the GL post?"). Redirect: "I'll figure that out with the team. Today I just need the business decision."
- **A philosophical accounting debate**. Redirect: "We can stay GAAP-standard. Anything specific we want to deviate from?"
- **Tooling questions** ("should we just use NetSuite?"). Redirect: "We've already decided to build native. Today's decisions are about the business config."

### After the meeting

For each Y/N decision: write it into the corresponding workstream doc as committed.

For each TBD: file a follow-up with owner + deadline.

For anything surprising: tell engineering immediately so we can adjust scope.

---

## Quick reference: what we're really asking

| Question | What we really want | Likely answer |
|---|---|---|
| Q1 Contract revenue stream | Should we add `4200 Contract Dev Revenue` to the COA? | YES if we have or expect any pharma development deals; NO if pure cartridge sales |
| Q2 R&D capitalization | Default to expensing? | YES (recommend expense everything; capitalization is a one-off CFO decision) |
| Q3 FIFO vs standard | Use FIFO at item level? | YES (recommend FIFO; standard costing is too heavy for our stage) |
| Q4 Warranty rate | Use what % for warranty reserve? | 1-2% to start (or actual % if history exists) |
| Q5 Pricing tiers | Direct vs distributor accounts? | Depends on commercial structure — one tier or two? |
| Q6 Sales tax nexus | Which states do we collect for? | Need explicit list; probably HQ state + employee states |
| Q7 Accrual vs cash | Accrual for everything? | YES (almost always for our stage) |
| Q8 Multi-entity | One company or many? | Probably one today; design for many |
| Q9 Cost allocation | What overhead driver? | Defer to Phase 6+; default no allocation |
| Q10 Quality-hold accounting | Auto-isolate or NCR-gated? | NCR-gated (aligns with ISO compliance) |
| Q11 Multi-company seed | Build for many companies? | Schema yes, seed one (cheap insurance) |

---

## What "good" looks like at the end

You walk out with:
- 11 yes/no/specific-value answers (or explicit TBDs with owners)
- Maybe 2-3 strategic insights you didn't have before (e.g., "We're already in talks with a distributor — that changes question 5")
- A 30-min "second pass" scheduled if the exec wants to think about #1, #4, or #5
- The exec feels they made decisions, not that they were ambushed by engineering jargon

The technical decisions follow naturally from these business answers. Engineering's job afterward is to translate them into models, routes, and acceptance criteria — that part you don't need to think about during the conversation.
