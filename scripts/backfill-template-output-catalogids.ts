/**
 * backfill-template-output-catalogids.ts
 *
 * One-shot: populate ReagentProtocolTemplate.outputSpec.catalogId on each of
 * the 6 active templates by matching against ReagentCatalog rows. Required so
 * finalize can create ReagentInventory rows pointing at the right catalog
 * entry per output.
 *
 * Heuristic matching uses template name → catalog name fuzzy match plus
 * category hint. Operator MUST review proposed matches in --review mode
 * before re-running with --apply. Idempotent: re-running --apply on a
 * template that already has outputSpec.catalogId set is a no-op unless
 * --force is passed.
 *
 * Usage:
 *   npx tsx scripts/backfill-template-output-catalogids.ts --review
 *   npx tsx scripts/backfill-template-output-catalogids.ts --apply
 *   npx tsx scripts/backfill-template-output-catalogids.ts --apply --force
 */

import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

// Per-template explicit catalog match. Curated against the live 78-entry
// catalog (2026-05-17 snapshot). Pragmatic defaults are used for multi-
// variant templates (SuperQD P1/P2) where the proper fix is to seed
// `outputSpecs[]` with one entry per variant — see PRD §6.1.
//
// Behavior: `exactName` if provided takes priority — case-insensitive exact
// match against ReagentCatalog.name. Falls back to `nameHint` substring
// match + optional `category` filter when no exact match found.
const TEMPLATE_HINTS: Record<
	string,
	{ exactName?: string; nameHint?: string; category: string | null; note?: string }
> = {
	'superqd-phase-1': {
		// 3 wavelength variants exist (480/555/630). Default to 480nm; the
		// proper fix is `outputSpecs[]` with one entry per wavelength.
		exactName: 'Super QD phase 1 — 480nm',
		category: 'QD',
		note: 'DEFAULT to 480nm — template should grow outputSpecs[] for all 3 wavelengths'
	},
	'superqd-phase-2': {
		// 8 target×wavelength variants exist. Default to Cortisol 480nm.
		// Proper fix is `outputSpecs[]` with entries per target×wavelength.
		exactName: 'Super QD phase 2 — Cortisol — 480nm',
		category: 'QD',
		note: 'DEFAULT to Cortisol/480nm — template should grow outputSpecs[] for all 8 variants'
	},
	'antibody-biotinylation': {
		// 2 antibody variants. Default to Cortisol (matches the other Cortisol
		// templates). Anti-goat-chicken variant would need separate outputSpec.
		exactName: 'Biotinylated antibody — Cortisol',
		category: 'antibody',
		note: 'DEFAULT to Cortisol — also exists for Anti-goat-chicken'
	},
	'hepes-cortisol-buffer': {
		// Closest single catalog entry. There is no "HEPES Cortisol Buffer"
		// catalog row; "HEPES base" is the foundational prepared HEPES item.
		exactName: 'HEPES base',
		category: 'other',
		note: 'No exact "HEPES Cortisol Buffer" catalog entry — using "HEPES base" as nearest match'
	},
	'cortisol-bead-mix': {
		// Several bead variants; Cortisol active beads is the target match.
		exactName: 'Active beads — Cortisol',
		category: 'bead'
	},
	'cortisol-tracer': {
		// Tracer in cortisol immunoassays = biotinylated antigen analog.
		// "Biotinylated BSA conjugate — Cortisol" is the protein-class match.
		exactName: 'Biotinylated BSA conjugate — Cortisol',
		category: 'protein',
		note: 'Tracer = biotinylated antigen analog; using BSA-conjugate cortisol row'
	}
};

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function main() {
	const args = new Set(process.argv.slice(2));
	const review = args.has('--review');
	const apply = args.has('--apply');
	const force = args.has('--force');

	if (!review && !apply) {
		console.error('Pass either --review (dry-run) or --apply.');
		process.exit(1);
	}
	if (review && apply) {
		console.error('Pass only one of --review / --apply, not both.');
		process.exit(1);
	}

	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const templates = await db
		.collection('reagent_protocol_templates')
		.find({}, { projection: { name: 1, slug: 1, version: 1, status: 1, outputSpec: 1 } })
		.toArray();

	console.log(`Found ${templates.length} templates.`);
	console.log('');

	let proposed = 0;
	let skippedAlreadySet = 0;
	let unresolved = 0;
	const writes: Array<{ _id: any; catalogId: string; name: string }> = [];

	for (const t of templates as any[]) {
		const slug = t.slug ?? '';
		const current = t.outputSpec?.catalogId ?? '';
		const hint = TEMPLATE_HINTS[slug];

		if (current && !force) {
			console.log(
				`  [SKIP] ${t.name} v${t.version} — outputSpec.catalogId already set to ${current}`
			);
			skippedAlreadySet++;
			continue;
		}

		if (!hint) {
			console.log(`  [UNRESOLVED] ${t.name} v${t.version} (slug=${slug}) — no hint configured`);
			unresolved++;
			continue;
		}

		// Try exact name match first (preferred). Fall back to nameHint substring + category.
		let matches: any[] = [];
		if (hint.exactName) {
			const exact = await db
				.collection('reagent_catalog')
				.find(
					{ name: new RegExp('^' + escapeRegex(hint.exactName) + '$', 'i') },
					{ projection: { name: 1, type: 1, category: 1 } }
				)
				.toArray();
			matches = exact;
		}
		if (matches.length === 0 && hint.nameHint) {
			const nameRegex = new RegExp(escapeRegex(hint.nameHint), 'i');
			const query: Record<string, unknown> = { name: nameRegex };
			if (hint.category) query.category = hint.category;
			matches = await db
				.collection('reagent_catalog')
				.find(query, { projection: { name: 1, type: 1, category: 1 } })
				.toArray();
		}

		if (matches.length === 0) {
			console.log(
				`  [UNRESOLVED] ${t.name} v${t.version} — no catalog match for hint ${JSON.stringify(hint)}`
			);
			unresolved++;
			continue;
		}

		// Prefer "prepared" type since these are outputs of a protocol.
		const preferred = matches.find((m: any) => m.type === 'prepared') ?? matches[0];

		console.log(`  [PROPOSED] ${t.name} v${t.version}`);
		console.log(
			`     → catalog ${(preferred as any)._id} "${(preferred as any).name}" (${(preferred as any).type}/${(preferred as any).category})`
		);
		if (hint.note) console.log(`     NOTE: ${hint.note}`);
		if (matches.length > 1) {
			console.log(
				`     (${matches.length} matches; using ${preferred === matches[0] ? 'first' : 'first prepared'}. Other candidates:)`
			);
			for (const m of matches.slice(0, 5) as any[]) {
				if (m._id === (preferred as any)._id) continue;
				console.log(`       - ${m._id} "${m.name}" (${m.type}/${m.category})`);
			}
		}
		proposed++;
		writes.push({ _id: t._id, catalogId: (preferred as any)._id, name: t.name });
	}

	console.log('');
	console.log(
		`Summary: proposed=${proposed} skippedAlreadySet=${skippedAlreadySet} unresolved=${unresolved}`
	);

	if (review) {
		console.log('');
		console.log('Dry-run. Re-run with --apply to write these matches.');
	} else if (apply && writes.length > 0) {
		console.log('');
		console.log(`Applying ${writes.length} updates...`);
		for (const w of writes) {
			await db
				.collection('reagent_protocol_templates')
				.updateOne({ _id: w._id }, { $set: { 'outputSpec.catalogId': w.catalogId } });
			console.log(`  Updated ${w.name} → catalogId=${w.catalogId}`);
		}
		console.log('Done.');
	}

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
