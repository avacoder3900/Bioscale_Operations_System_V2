# Prepping for the Finance Conversation

A note to walk you through what we're asking, why, and how to think about each piece. Read it once before the meeting. The intent is to leave you fluent enough to lead the discussion without reading off a list.

## What just happened

I had a background agent review the nine strategy docs we wrote yesterday. It came back saying we had three issues: a model count off by one, a function count off by two, and a tool count off by thirteen. The first two were real and I fixed them. The third was wrong — the agent miscounted. I checked the file directly, and the doc was right all along. Worth noting because it's a reminder that even agents reviewing other agents can be wrong, and we should always sanity-check claims about counts before we believe them.

The docs are now in good shape. They're ready for tomorrow's team conversation, and they're ready for the executive conversation about the financial layer.

## The big picture

We're adding an ERP — a financial layer — to BIMS. Today, BIMS knows everything about the physical world: cartridges, runs, equipment, lots, who scanned what when. It knows nothing about money. After this work lands, BIMS will be able to answer questions like "what does it cost us to make one cartridge today?" and "what's our margin per assay?" and "where's our inventory dollars sitting right now?"

We're not buying NetSuite or SAP. We're building it native to BIMS, using ERPNext (an open-source ERP) as our blueprint. Same accounting rules, same data shapes, but it lives in our system and feels like part of it.

The conversation with your superior is to lock in the business decisions that make this work. There are eleven of them. Engineering can pick reasonable defaults for everything, but a handful of these are real strategic choices that need a business owner's call. The other ones we just need a yes-and-go-ahead on. The whole conversation should take 30-45 minutes.

## What you need to know about the language

Some of the words in those questions look intimidating if you're not in finance every day. Here's what they actually mean.

A **chart of accounts** is just the named buckets the company tracks money in. There's a tree: Assets, Liabilities, Equity, Revenue, Expenses, drilling down into specific buckets like "Finished Goods Inventory" or "Cartridge Sales" or "Wax Defect Scrap." When we ask if contract development should be its own revenue stream, we're really asking whether to add a separate bucket for it.

The **general ledger** is the transaction log. Every time money moves, two entries get made: one debit, one credit, and they have to sum to zero. Sell a cartridge for $100, you debit Cash and credit Cartridge Sales. The general ledger is the append-only history of all those entries. You'll hear "GL" a lot. It's just the log.

The **stock ledger** is the same idea but for inventory. Every time a cartridge moves between warehouses or gets consumed in a run or gets shipped, the stock ledger gets a row. Each stock-ledger row produces matching general-ledger rows so the dollars track the units.

**FIFO** stands for first-in-first-out. When you sell something, the cost you charge against that sale is the cost of the oldest unit you have. If you bought 100 widgets at $5 last month and 100 at $6 this month, the next 50 you sell are valued at $5 each, because those came in first. The alternative is **standard costing**, where every widget gets a fixed pre-set cost, and the difference between actual and the standard becomes a "variance" you analyze separately. Standard costing is operationally heavier and more common at large mature manufacturers. We're recommending FIFO. Most companies our size do FIFO.

**GAAP** is the US accounting rulebook. Like an RFC for accountants. There are specific rules for things like when you can recognize revenue and how you have to value inventory. When your exec uses the word, they mean "follows the standard." Our system is GAAP-compliant by default; we just need to confirm a few choices that GAAP allows you to make either way.

**Accrual** versus **cash basis** is about timing. Cash basis means you record a transaction when money actually moves. Accrual means you record it when the obligation happens — when you ship the product (revenue earned) or take the service (expense incurred), regardless of when the bill gets paid. GAAP requires accrual. Almost every company that's actively raising money is on accrual. We just want to confirm that.

**Capitalization** of R&D means treating R&D spending as an asset on the balance sheet rather than as an expense on the income statement. If you capitalize, you put the spending on a depreciation schedule and gradually expense it over years. It makes today's profit look better but creates an asset you have to test for impairment annually. Almost no pre-IPO company does this. The default is to expense everything, and that's what we're recommending. Capitalizing requires a CFO sign-off and is mostly an investor-optics decision.

**Warranty reserve** is something most engineers don't think about. When you sell a product with a warranty, accounting rules require you to set aside money at the moment of sale to cover the expected future returns. If you sell a million dollars of cartridges and 1% of them come back, you have to put $10K on the balance sheet as a warranty liability the day you book the revenue. This isn't optional under GAAP. We need to know the warranty period and the failure rate to set the rate.

**Nexus** is the legal term for a state's right to require you to collect sales tax. A state has nexus over you if you have employees there, inventory there, an office there, or — since the Wayfair case in 2018 — if you sell a lot to customers there (typically over $100K a year, or 200 transactions). Different states have different rules. The system needs to know which states we collect for, because mis-collecting is a real liability. We collect too little, the state sends us a bill for back taxes plus penalties.

**Multi-currency** means operating in more than one currency. Foreign customers paying in euros, exchange rates fluctuating, gain/loss accounting on the swings. Our recommendation is to design the schemas with currency fields now, but not turn it on until we have a real foreign customer. Cheap to build, expensive to retrofit.

**Multi-entity** or **consolidation** means having multiple legal entities — say, a parent company plus a subsidiary plus an IP holding company — and combining their books at quarter end. Most early-stage companies are single-entity. Adding the foreign-key field for company on every transaction now is cheap; retrofitting later is painful. So we want to design for many but seed one.

**Cost centers** are department tags on transactions. When the manufacturing team buys lab supplies, you tag the expense with "Manufacturing-WaxFilling" so you can later report on what wax filling cost us this quarter. They live in the chart of accounts alongside the dollar buckets.

**Period close** is the end-of-month or end-of-quarter act of locking the books so nobody can backdate entries. Without it, the financial statements aren't reliable because someone could always edit history. With it, the books are stable.

The **audit trail** is the immutable log of who did what when. GAAP requires it. 21 CFR Part 11, the FDA's electronic records rule, also requires it. BIMS already has an audit log model; we'll extend it for financial events. This isn't optional and the exec will assume it exists.

**Cost of quality** is the financial term for tracking dollars lost to scrap and defects. When you scrap a cartridge, the dollars that were in that unit's inventory don't disappear — they move from the inventory account to a scrap-expense account. This is one of the highest-value reports the financial layer will produce. It lets us answer "how much did wax-fill rejection cost us this month?" with a real number.

A **non-conformance report** or NCR is a formal QMS record that a batch didn't meet spec, with a disposition decision: use as-is, rework, or scrap. ISO 13485 and 21 CFR 820 require this for any quality issue. The QMS expansion plan introduces this model. The accounting question is whether we move inventory to a quality-hold sub-account on every QC failure, or only when an NCR is formally opened. We're recommending NCR-gated, because that aligns with how regulated companies actually work.

That's most of the vocabulary. If your exec uses a term I haven't covered, ask. They'll be happy to explain it.

## Where our thinking is

We've made tentative recommendations on every question and we're asking your exec mostly to confirm or override. Here's the rationale on the recommendations.

For costing, we want FIFO at the item level. Standard costing requires a labor and overhead module BIMS doesn't have, and the small benefits aren't worth the complexity at our stage. Most diagnostics companies under $50M revenue use FIFO.

For R&D treatment, we want to expense everything. Capitalization is mostly a CFO-driven optics call, almost never how pre-IPO companies actually operate, and ASC 730 (the GAAP rule for R&D) generally requires expensing unless very narrow criteria apply. If your exec wants to capitalize anything, they'll have a specific reason and we'll handle it as a one-off.

For accrual versus cash, we want accrual everywhere. GAAP requires it for financial statements. The only place cash basis is sometimes used is the IRS filing, and even then most companies that intend to raise money use accrual. The system always knows accrual; it's not really an engineering choice.

For multi-entity, we want a single-entity seed but a schema that supports many. The marginal cost of adding the company field everywhere now is small — call it five percent extra effort. The cost of retrofitting later when we open a UK subsidiary or want an IP holding company is large.

For multi-currency and sales tax, we want schema-first and enforce-later. Add the fields now so we don't have to refactor when the first foreign customer lands or when nexus exposure crosses a threshold. Don't actually run the calculations until needed.

For quality holds, we want NCR-gated rather than auto-isolate. ISO compliance basically requires an NCR for any disposition decision anyway, so triggering the accounting move on the NCR keeps the books and the QMS aligned without operational noise.

These are the defaults. Your exec mostly has to nod or override.

## What you actually need from your exec

The eleven questions split into two groups. Six of them, you can essentially ask for a confirmation of the default. The exec will say "yeah, fine" and you move on. Those are R&D capitalization, accrual versus cash, multi-entity, multi-company schema, cost allocation drivers, and quality-hold accounting. None of these are really business decisions; they're engineering choices that need a sanity check.

The other five are real strategic questions where the exec genuinely owns the answer.

The first is whether contract development is a separate revenue stream. If Bioscale has or is pursuing pharma deals where a partner pays us to develop a custom assay, that's a different revenue stream from cartridge sales, with different revenue-recognition rules. Worth asking flat out: "Are we doing any work-for-hire today? Do we expect to in the next 12 months?"

The second is FIFO versus standard costing. We're recommending FIFO; we just want their nod. If they have a reason to prefer standard, that's a substantial extra build and we should know.

The third is warranty terms and historical failure rates. This is tied to whatever customer agreements we have. The exec will know the warranty period because it's in the customer contract. They may or may not know the historical failure rate. If we don't have history yet, we estimate; one to two percent is typical for diagnostic devices.

The fourth is pricing tiers and sales channels. Do we sell direct only, or through distributors? Are there research-use customers paying different prices than clinical labs? Whatever the commercial structure is, the chart of accounts has to mirror it. Ask: "Today, who do we sell to? Are all our prices public, or do we have distributor agreements?"

The fifth is sales tax nexus. The exec will know where our employees are physically located, whether we're registered with any state Departments of Revenue, and roughly which states we ship to most. Get an explicit list. We don't want to under-collect.

If you walk out of the meeting with clear answers to those five — even if they're "we don't know yet, let me check" with a date — the rest will fall into place.

## How to run the meeting

I'd open with a frame like this: "We're adding a financial layer to BIMS. Engineering can pick reasonable defaults, but for these eleven decisions, the default has business implications and you should sign off. I have the questions; each takes about two minutes." Then walk through the list.

Listen for what kind of answer you're getting. If they say "yes, we already do that, it's [specific thing]" — write it down literally. If they say "I don't know, ask Mary" — mark TBD with the owner and move on. If they say "why are you asking, just make the call" — confirm the engineering default verbally and move on. If they go quiet and start thinking — let them. That's a real strategic question and it deserves the time.

Don't let the meeting drift into implementation details. If they ask how the GL posting works, redirect with "I'll figure that out with the team. Today I just need the business decision." Don't let it drift into a philosophical accounting debate either; we're staying GAAP-standard unless they specifically want to deviate. Don't let it drift into tooling questions like "should we just use NetSuite" — we've already decided to build native; today is about the configuration.

The good outcome looks like this: you have eleven yes/no answers (or explicit TBDs with owners), maybe two or three strategic insights you didn't have going in, and the exec feels they made decisions rather than getting ambushed by jargon.

When you're done, just paste the answers into our next chat and I'll roll them into the ERP master plan as committed defaults. The technical decisions follow naturally from the business answers. That part you don't have to think about.
