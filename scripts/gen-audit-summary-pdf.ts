import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';

const OUT = path.resolve('docs/audit-summary-plain-english-2026-04-24.pdf');

const COLOR = {
	text: '#111111',
	muted: '#555555',
	accent: '#0a5fa8',
	danger: '#b91c1c',
	warn: '#b45309',
	ok: '#15803d',
	hr: '#d4d4d4'
};

const doc = new PDFDocument({
	size: 'LETTER',
	margins: { top: 72, bottom: 72, left: 72, right: 72 },
	info: {
		Title: 'BIMS System Audit — Plain English',
		Author: 'BIMS Audit',
		Subject: 'Plain-language summary of the 2026-04-24 audit findings',
		Keywords: 'audit bims plain-english'
	}
});

doc.pipe(fs.createWriteStream(OUT));

function hr() {
	doc.moveDown(0.5);
	doc.strokeColor(COLOR.hr).lineWidth(0.5)
		.moveTo(doc.page.margins.left, doc.y)
		.lineTo(doc.page.width - doc.page.margins.right, doc.y)
		.stroke();
	doc.moveDown(0.8);
}

function h1(text: string) {
	doc.moveDown(0.5);
	doc.fillColor(COLOR.accent).font('Helvetica-Bold').fontSize(20).text(text);
	doc.moveDown(0.3);
}

function h2(text: string, color = COLOR.text) {
	doc.moveDown(0.8);
	doc.fillColor(color).font('Helvetica-Bold').fontSize(14).text(text);
	doc.moveDown(0.2);
}

function h3(text: string, color = COLOR.text) {
	doc.moveDown(0.4);
	doc.fillColor(color).font('Helvetica-Bold').fontSize(11.5).text(text);
	doc.moveDown(0.1);
}

function p(text: string) {
	doc.fillColor(COLOR.text).font('Helvetica').fontSize(11).text(text, {
		align: 'left',
		lineGap: 2
	});
	doc.moveDown(0.4);
}

function quote(text: string) {
	doc.fillColor(COLOR.muted).font('Helvetica-Oblique').fontSize(10.5).text(text, {
		align: 'left',
		indent: 18,
		lineGap: 2
	});
	doc.moveDown(0.4);
}

function bullet(items: string[]) {
	doc.fillColor(COLOR.text).font('Helvetica').fontSize(11);
	for (const item of items) {
		doc.text(`• ${item}`, { indent: 12, lineGap: 2 });
		doc.moveDown(0.15);
	}
	doc.moveDown(0.3);
}

// ── Cover block ────────────────────────────────────────────────────────────
doc.fillColor(COLOR.accent).font('Helvetica-Bold').fontSize(26)
	.text('BIMS Audit — Plain English', { align: 'left' });
doc.moveDown(0.2);
doc.fillColor(COLOR.muted).font('Helvetica').fontSize(12)
	.text('A walkthrough of what we checked and what we found, written without the jargon.');
doc.moveDown(0.4);
doc.fillColor(COLOR.muted).fontSize(10)
	.text('Date: 2026-04-24  ·  Branch: dev  ·  Reader level: anyone');
hr();

// ── What is this? ──────────────────────────────────────────────────────────
h2('What is BIMS, and what got audited?');
p(`BIMS is the software that runs the factory floor at a biotech company. It tracks little plastic diagnostic cartridges — the kind that test blood or samples for specific things — from the moment their raw materials show up, through being built by robots, to being shipped to customers.`);
p(`Over the past two days a bunch of new features were added: a "research mode" for the robots, a new way to manually remove cartridges from a fridge, a big analytics dashboard, and a structural rewrite of how cartridges get created in the first place. When that much changes that fast, you want someone to check nothing broke. That's what this report is.`);

// ── Bottom line first ──────────────────────────────────────────────────────
h2('The short version', COLOR.accent);
p(`The system is in solid shape. One brand-new button is broken before it even ships (easy fix). A handful of sidebar links go nowhere. There are 14 mystery cartridges in the database we need to talk about. Other than that, everything we checked works.`);

// ── Good news ──────────────────────────────────────────────────────────────
h2('What is working correctly', COLOR.ok);
p(`Most of the factory-floor logic checks out. Specifically:`);
bullet([
	`Every place in the code that spends or creates parts — think raw material going in, cartridges coming out — does the paperwork correctly. That matters a lot because this is medical-device-adjacent, so every transaction needs an audit trail.`,
	`The safety locks on the lab robots are solid. Seven different places in the code check "is this robot busy right now?" and all seven answer the same way. If they disagreed, two operators could try to use the same robot at once.`,
	`Refrigerator and oven counts are consistent across every page that shows them — the dashboard, the equipment page, and the location detail page all agree.`,
	`The new analytics dashboard loads all 11 of its tabs (overview, cycle time, yield, etc.) without crashing. There is also a "demo mode" version behind a password that shows fake data for training purposes.`,
	`The "research run" feature works end-to-end. You can tell the robot "this is just an experiment, no specific test assigned" and cartridges flow through every stage without anything choking on the missing assignment.`,
	`The big structural rewrite — where cartridges only "exist" once someone scans a physical barcode at the robot, not earlier — is coherent. The guard that prevents pulling more cartridges from a storage bucket than the bucket actually contains is in place and tested.`
]);

// ── Bad news (blockers) ────────────────────────────────────────────────────
h2('What is broken and needs fixing', COLOR.danger);

h3('1. The new "Go Back" button will crash the first time someone uses it', COLOR.danger);
p(`There is code being written right now that lets an operator rewind a wax-filling run by one step — like an undo button. The problem: the code tries to DELETE records from a log that the system is designed to never allow deletions from. Think of it like the log being a ledger written in permanent ink. The code is trying to erase a line. The system will refuse and throw an error.`);
p(`The fix is small: instead of deleting, mark the entries as "retracted." That's actually already a supported pattern elsewhere in the same system. Maybe two lines of code to swap.`);

h3('2. Some sidebar links lead to nowhere', COLOR.danger);
p(`On the SPU page, three or four buttons in the left sidebar point to URLs that do not exist. If you click them, you get a 404. Specifically:`);
bullet([
	`"Particle Settings" — the real page is at a different address`,
	`"BOM Settings" and "BOM Settings Mapping" — same issue`,
	`"Receiving" — we need to decide where it should actually point`
]);

h3('3. The Receiving pages are broken when you navigate between them', COLOR.danger);
p(`Inside the Receiving section, the routes have a quirk: they are named with a leading underscore (/_receiving/). But the buttons INSIDE those pages link to the same address without the underscore (/receiving/). So if you are on a receiving page and click one of the navigation buttons, you get lost. Fix is a search-and-replace in five spots.`);

// ── Yellow flags ───────────────────────────────────────────────────────────
h2('Things worth noting (not broken, but deserve attention)', COLOR.warn);

h3('14 mystery cartridges');
p(`There are 14 cartridge records marked as "completed" with no history at all. No raw material lot, no robot run, no quality check, nothing. They just appear in the database with a creation date on 2026-04-23. You mentioned yesterday that the "orphan cartridges are taken care of," but those same 14 records are still exactly where I left them. Either we are talking about different cartridges, or something happened that did not fully resolve them. Worth confirming.`);

h3('A paperwork gap on 30 old cartridges');
p(`This week a new "checkout" concept was added: instead of saying "this cartridge was destroyed" when someone removes it from a fridge, the system now says "this cartridge was checked out, it may still be fine." Thirty cartridges were retroactively imported into the new system, but because they predate the audit-trail convention, they don't have the specific "CHECKOUT" audit line. Their records exist, they're findable — they just look slightly different from anything checked out going forward. If compliance queries look for that specific audit tag, they will miss these 30. A one-time script to backfill the tag would close the gap.`);

h3('Other minor stuff');
bullet([
	`One small audit-trail hole on WI-01 notes updates — the code updates the note but doesn't include it in the audit entry.`,
	`The same "Go Back" button from the blocker list also forgets to write an audit line for itself. While you are fixing the crash, add the audit write too.`,
	`When you later assign an experimental research cartridge to a real test, the UI doesn't flag it as "this was a research run." Easy UX improvement, not a bug.`,
	`The checkout page could, in theory, create a duplicate record if the user's network hiccups and the form resubmits. Very unlikely to happen in practice.`
]);

// ── What "checkout" means ──────────────────────────────────────────────────
h2('A concept that changed this week: checkout vs. scrap');
p(`Worth explaining because it changed in the middle of the work and the documentation is still catching up.`);
p(`Before: when an operator manually took a cartridge out of a fridge, the system flagged it as "scrapped" — destroyed, gone, consumed. Every such action logged a scrap transaction.`);
p(`After: the system recognizes that physically removing a cartridge is not the same as destroying it. You might be moving it for testing, sending it somewhere, or actually scrapping it. These are different things. Now the manual-removal action just records "this cartridge left the fridge" without making assumptions about what happens next. The cartridge keeps whatever status it already had.`);
quote(`Analogy: before, taking a book off a library shelf told the system "this book was burned." Now it just says "someone has this book." Same physical action, much more accurate record.`);
p(`This change explains why some handoff documents from yesterday talk about "scrap transactions" from the manual-removal feature — that language describes the old behavior. The actual code today doesn't do that.`);

// ── A real incident that got handled ───────────────────────────────────────
h2('An incident from this week that went well');
p(`On 2026-04-23 someone did a physical audit of one of the refrigerators. The computer said 78 cartridges were inside. The physical count came up with 59. Twenty cartridges were missing.`);
p(`The response was to file 20 individual "checkout" records — one per missing cartridge — with enough notes to trace where each one probably went (8 were attributed to a testing session from a week earlier; 12 to a longer pattern across multiple days). Dashboards got amber and red warning banners. A Kanban task got created to improve tracking going forward.`);
p(`From a data-integrity perspective, this is a clean recovery: the physical/digital gap is now acknowledged in the database, the 20 cartridges each have a paper trail, and the fact that they were unaccounted for is visible to anyone who looks. This was a good test of the new checkout system and it passed.`);

// ── Decisions needed ───────────────────────────────────────────────────────
h2('Decisions we need from you', COLOR.accent);
bullet([
	`About the 14 mystery cartridges: what did "taken care of" mean? Still open, or resolved in a way I did not see?`,
	`The SPU sidebar "Receiving" link: should it point to the Receiving-Of-Goods page, or the internal receiving flow? (They are two different UIs.)`,
	`The 30 old cartridges missing the CHECKOUT audit tag: back-fill the tag, or leave it as documented historical delta?`,
	`There is one wax quality-check run (code name g1Hg16k8b) still flagged in memory as "not rolled back." Today the tooling to do it through the app has the crash bug mentioned above; if you want to do it now, a one-off script is needed. Or wait until the "Go Back" button is fixed.`,
	`There is a code path that lets a cartridge be created for the first time at the reagent-filling stage (skipping wax-filling entirely). Real flow or legacy defensive code that can be deleted?`
]);

// ── Wrap ──────────────────────────────────────────────────────────────────
h2('Wrap-up', COLOR.accent);
p(`None of this is urgent in the sense of "the system is on fire." The fridge incident was caught and handled. The live database is coherent. The new features that shipped work. The one blocker is in code that has not been committed yet, so it has not actually hurt anyone — it is a trip-wire waiting for a click, and the fix is small.`);
p(`Sign off on the decisions above and we can close out the to-do list from this audit cycle.`);

doc.end();

doc.on('end', () => {
	console.log(`PDF written: ${OUT}`);
});
