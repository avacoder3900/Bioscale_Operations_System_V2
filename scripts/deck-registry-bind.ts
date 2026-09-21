/**
 * DECK-VC-2 — bind each deck Equipment row to the labware definition the robot
 * will actually load, and archive deck rows that no longer have one.
 *
 * WHY THIS EXISTS
 * The operator picks a deck in BIMS (DECK-004). The robot independently decides
 * which cartridge-deck definition to load by reading a Particle device id over
 * USB serial and looking it up in a dict inside the fill protocol. Nothing
 * connected those two facts, so calibrating "DECK-001" in the Studio could
 * correct a definition the robot never loads. `deck_calibration_edits` has a
 * `deckEquipmentId` field for exactly this and it is null on every one of the
 * ~47k rows.
 *
 * WHAT IT DOES
 *  1. Parses the Particle-id -> deck-loadName map straight out of the fill
 *     protocols, so the binding comes from the code the robot runs, not from a
 *     constant re-typed here.
 *  2. Binds Equipment.deckLoadName + Equipment.particleDeviceId.
 *  3. Archives (never deletes) deck rows whose definition no longer exists.
 *
 * ARCHIVING RULE: a deck is archived when its derived loadName has no document
 * in `labware_definitions` AND it is referenced by no wax run and no reagent
 * batch record. A deck with history is always kept, whatever its state.
 *
 * NOTE ON THE SUFFIX CONVENTION: DECK-00N is matched to
 * gen4deck_gen7cartridge_00N by numeric suffix, because that is the convention
 * the floor already runs on. It is a CONVENTION, not a measurement — the whole
 * point of writing particleDeviceId down is that it can now be verified against
 * the physical deck. Confirm each binding on the bench before trusting it.
 *
 * Usage:
 *   MONGODB_URI=... npx tsx scripts/deck-registry-bind.ts --plan
 *   MONGODB_URI=... npx tsx scripts/deck-registry-bind.ts --apply
 */
import fs from 'node:fs';
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { generateId } from '../src/lib/server/db/utils.js';
import { deckParticleMap } from '../src/lib/server/opentrons/labware-refs.js';

const MODE: 'plan' | 'apply' | null = (() => {
	if (process.argv.includes('--apply')) return 'apply';
	if (process.argv.includes('--plan')) return 'plan';
	return null;
})();
if (!MODE) {
	console.error('Usage: npx tsx scripts/deck-registry-bind.ts --plan | --apply');
	process.exit(1);
}

const OPERATOR = 'system-deck-registry-bind';
const PROTOCOLS = [
	'protocols/Wax_Filling_GEN7_Cartridge.py',
	'protocols/Reagent_Filling_GEN7.py'
];

/** DECK-004 -> "004". Null when the id carries no numeric suffix. */
function deckSuffix(id: string): string | null {
	const m = /(\d+)\s*$/.exec(String(id ?? ''));
	return m ? m[1] : null;
}

async function main() {
	const uri = process.env.MONGODB_URI;
	if (!uri) {
		console.error('MONGODB_URI is not set. Export it before running.');
		process.exit(1);
	}

	// 1. Particle id -> deck loadName, read from the protocols themselves.
	const particleToDeck: Record<string, string> = {};
	for (const p of PROTOCOLS) {
		if (!fs.existsSync(p)) {
			console.warn(`  (protocol not found, skipping: ${p})`);
			continue;
		}
		Object.assign(particleToDeck, deckParticleMap(fs.readFileSync(p, 'utf8')));
	}
	const deckToParticle = new Map<string, string>();
	for (const [pid, deck] of Object.entries(particleToDeck)) deckToParticle.set(deck, pid);

	console.log(`Particle map parsed from protocols: ${deckToParticle.size} deck(s)`);
	for (const [deck, pid] of deckToParticle) console.log(`   ${deck}  <-  ${pid}`);
	console.log('');

	await mongoose.connect(uri);
	const db = mongoose.connection.db!;
	console.log(`[${MODE}] connected to ${db.databaseName}\n`);

	const defs = (await db
		.collection('labware_definitions')
		.find({}, { projection: { loadName: 1, namespace: 1, version: 1 } })
		.toArray()) as any[];
	const defByLoadName = new Map(defs.map((d) => [String(d.loadName), d]));

	const decks = (await db
		.collection('equipment')
		.find({ equipmentType: 'deck' })
		.toArray()) as any[];

	console.log(`equipment decks: ${decks.length}\n`);

	let bound = 0;
	let archived = 0;
	let kept = 0;

	for (const deck of decks.sort((a, b) => String(a._id).localeCompare(String(b._id)))) {
		const id = String(deck._id);
		const suffix = deckSuffix(id);
		const derived = suffix ? `gen4deck_gen7cartridge_${suffix}` : null;
		const hasDef = derived ? defByLoadName.has(derived) : false;
		const particleId = derived ? (deckToParticle.get(derived) ?? null) : null;

		// Never archive a deck that history points at.
		const waxRefs = await db.collection('wax_filling_runs').countDocuments({ deckId: id });
		const reagentRefs = await db
			.collection('reagent_batch_records')
			.countDocuments({ deckId: id });
		const refs = waxRefs + reagentRefs;

		if (hasDef && derived) {
			const needsBind =
				deck.deckLoadName !== derived ||
				(particleId != null && deck.particleDeviceId !== particleId);
			console.log(
				`  BIND   ${id} -> ${derived}` +
					(particleId ? `  particle=${particleId}` : '  particle=UNKNOWN (not in protocol map)') +
					`  refs=${refs}` +
					(needsBind ? '' : '  (already bound)')
			);
			if (needsBind && MODE === 'apply') {
				const set: Record<string, unknown> = { deckLoadName: derived };
				if (particleId) set.particleDeviceId = particleId;
				await db.collection('equipment').updateOne({ _id: deck._id as any }, { $set: set });
				await db.collection('audit_log').insertOne({
					_id: generateId(),
					tableName: 'equipment',
					recordId: id,
					action: 'deck_binding_set',
					oldData: {
						deckLoadName: deck.deckLoadName ?? null,
						particleDeviceId: deck.particleDeviceId ?? null
					},
					newData: set,
					changedAt: new Date(),
					changedBy: OPERATOR
				} as any);
			}
			if (needsBind) bound++;
			kept++;
			continue;
		}

		// No definition for this deck.
		if (refs > 0) {
			console.log(
				`  KEEP   ${id} — no definition (${derived ?? 'no suffix'}) but ${refs} run reference(s); not archiving`
			);
			kept++;
			continue;
		}

		if (deck.archivedAt) {
			console.log(`  SKIP   ${id} — already archived`);
			continue;
		}

		console.log(
			`  ARCHIVE ${id} — no definition (${derived ?? 'no suffix'}), 0 run references, lastUsed=${deck.lastUsed ? new Date(deck.lastUsed).toISOString().slice(0, 10) : 'never'}`
		);
		if (MODE === 'apply') {
			await db.collection('equipment').updateOne(
				{ _id: deck._id as any },
				{
					$set: {
						archivedAt: new Date(),
						archivedBy: OPERATOR,
						archivedReason:
							'No cartridge-deck labware definition and no run history — not part of the current deck set.'
					}
				}
			);
			await db.collection('audit_log').insertOne({
				_id: generateId(),
				tableName: 'equipment',
				recordId: id,
				action: 'deck_archived',
				oldData: { archivedAt: null, status: deck.status ?? null },
				newData: { archivedAt: new Date(), reason: 'not in current deck set' },
				changedAt: new Date(),
				changedBy: OPERATOR
			} as any);
		}
		archived++;
	}

	console.log(
		`\n${MODE === 'apply' ? 'APPLIED' : 'would apply'} — bound: ${bound}   archived: ${archived}   kept: ${kept}`
	);
	if (MODE === 'plan') console.log('\nRe-run with --apply to write. Nothing is ever deleted.');

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error('FAILED:', e);
	process.exit(1);
});
