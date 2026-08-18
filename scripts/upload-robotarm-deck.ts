/**
 * upload-robotarm-deck.ts — upsert the Robot Arm Deck labware definition into Mongo.
 *
 * Equivalent to POST /api/opentrons-lab/labware, but runnable from the CLI.
 * Keyed on (namespace, loadName, version) exactly like the API, so re-running
 * is idempotent — it updates the same row rather than creating a duplicate.
 *
 * EVERY identity value (namespace / loadName / version / displayName / category)
 * is READ OUT OF THE ARTIFACT FILE. Nothing is hard-coded, so the row in Mongo
 * cannot drift from the JSON that was validated.
 *
 * Usage:
 *   npx tsx scripts/upload-robotarm-deck.ts                # DRY RUN (default)
 *   npx tsx scripts/upload-robotarm-deck.ts --commit       # actually write
 *
 *   --file <path>  artifact to upload   (default: labware/robotarm_cartridge_deck_001.json)
 *   --env  <path>  .env holding MONGODB_URI
 */
import * as dotenv from 'dotenv';
import mongoose, { Schema } from 'mongoose';
import { readFileSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => {
	const i = argv.indexOf(n);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const COMMIT = argv.includes('--commit');
const ARTIFACT = resolve(flag('--file', resolve(HERE, '..', 'labware', 'robotarm_cartridge_deck_001.json'))!);
const ENV_PATH = resolve(flag('--env', resolve(HERE, '..', '.env'))!);
const ACTOR = flag('--actor', 'alejandrov@fannininnovation.com')!;

dotenv.config({ path: ENV_PATH });
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
	console.error(`MONGODB_URI not found (looked in ${ENV_PATH})`);
	process.exit(1);
}

// Minimal local schemas — deliberately NOT importing the app models, which pull
// in SvelteKit $env aliases that do not resolve outside the app build.
const nano = () =>
	'xxxxxxxxxxxxxxxxxxxxxx'.replace(/x/g, () =>
		'useandom26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict'[Math.floor(Math.random() * 62)]
	);

const LabwareDefinition =
	mongoose.models.LabwareDefinition ||
	mongoose.model(
		'LabwareDefinition',
		new Schema(
			{
				_id: { type: String, default: nano },
				namespace: { type: String, required: true },
				loadName: { type: String, required: true },
				version: { type: Number, required: true, default: 1 },
				displayName: String,
				category: String,
				fileName: String,
				definition: { type: Schema.Types.Mixed, required: true },
				uploadedBy: String
			},
			{ timestamps: true }
		),
		'labware_definitions'
	);

const AuditLog =
	mongoose.models.AuditLog ||
	mongoose.model(
		'AuditLog',
		new Schema(
			{
				_id: { type: String, default: nano },
				action: String,
				resourceType: String,
				resourceId: String,
				userId: String,
				username: String,
				timestamp: Date,
				details: Schema.Types.Mixed
			},
			{ timestamps: false, strict: false }
		),
		'audit_logs'
	);

const User =
	mongoose.models.User ||
	mongoose.model(
		'User',
		new Schema({ _id: String, username: String, email: String }, { strict: false }),
		'users'
	);

async function main() {
	// ---- read + sanity-check the artifact -------------------------------
	const raw = readFileSync(ARTIFACT, 'utf8');
	const def = JSON.parse(raw);

	const namespace: string = def.namespace;
	const loadName: string = def.parameters?.loadName;
	const version: number = Number(def.version ?? 1);
	const displayName: string = def.metadata?.displayName;
	const category: string = def.metadata?.displayCategory;
	const wellCount = Object.keys(def.wells ?? {}).length;

	const bad: string[] = [];
	if (Number(def.schemaVersion) !== 2) bad.push(`schemaVersion is ${def.schemaVersion}, expected 2`);
	if (!namespace) bad.push('namespace missing');
	if (!loadName) bad.push('parameters.loadName missing');
	if (!Number.isFinite(version)) bad.push('version is not a number');
	if (!wellCount) bad.push('definition has no wells');
	if (!/(gen4deck|cartridge_deck)/i.test(loadName || ''))
		bad.push(`loadName "${loadName}" will NOT match the studio's DECK_RE — it would upload but never appear`);
	if (bad.length) {
		console.error('Refusing to upload:\n  - ' + bad.join('\n  - '));
		process.exit(1);
	}

	console.log('=== Robot Arm Deck -> Mongo ===');
	console.log(`artifact   ${ARTIFACT}`);
	console.log(`cluster    ${MONGODB_URI!.replace(/(mongodb\+srv:\/\/|mongodb:\/\/)[^@]*@/, '$1<redacted>@')}`);
	console.log(`key        namespace=${namespace}  loadName=${loadName}  version=${version}`);
	console.log(`displayName ${displayName}`);
	console.log(`category    ${category}`);
	console.log(`wells       ${wellCount}`);
	console.log(`mode       ${COMMIT ? 'COMMIT (writing)' : 'DRY RUN (no write)'}`);

	await mongoose.connect(MONGODB_URI!, { serverSelectionTimeoutMS: 15000 });
	console.log('connected');

	const existing: any = await LabwareDefinition.findOne({ namespace, loadName, version }).lean();
	console.log(
		existing
			? `existing   FOUND _id=${existing._id} (wells=${Object.keys(existing.definition?.wells ?? {}).length}) -> will UPDATE in place`
			: 'existing   none -> will INSERT a new row'
	);

	// Show what else the studio already lists, so a collision is obvious.
	const decks: any[] = await LabwareDefinition.find({}, { loadName: 1 }).lean();
	const visible = decks.map((d) => d.loadName).filter((n) => /(gen4deck|cartridge_deck)/i.test(n));
	console.log(`studio currently lists ${visible.length} deck(s): ${visible.join(', ') || '(none)'}`);

	if (!COMMIT) {
		console.log('\nDRY RUN — nothing written. Re-run with --commit to apply.');
		await mongoose.disconnect();
		return;
	}

	// ---- write ----------------------------------------------------------
	const actor: any = await User.findOne({ $or: [{ email: ACTOR }, { username: ACTOR }] }, { username: 1 }).lean();

	const res = await LabwareDefinition.findOneAndUpdate(
		{ namespace, loadName, version },
		{
			$set: {
				displayName,
				category,
				fileName: basename(ARTIFACT),
				definition: def,
				uploadedBy: actor?.username ?? ACTOR
			},
			$setOnInsert: { _id: nano() }
		},
		{ upsert: true, new: true, setDefaultsOnInsert: true }
	).lean();

	const saved = res as any;
	console.log(`\nwrote _id=${saved._id}  wells=${Object.keys(saved.definition?.wells ?? {}).length}`);

	await AuditLog.create({
		_id: nano(),
		action: existing ? 'update' : 'create',
		resourceType: 'labware_definition',
		resourceId: saved._id,
		userId: actor?._id ?? 'script',
		username: actor?.username ?? ACTOR,
		timestamp: new Date(),
		details: {
			namespace,
			loadName,
			version,
			wellCount,
			source: 'scripts/upload-robotarm-deck.ts',
			artifact: basename(ARTIFACT)
		}
	});
	console.log('audit log written');

	// ---- read back and verify against the file --------------------------
	const back: any = await LabwareDefinition.findOne({ namespace, loadName, version }).lean();
	const bw = back?.definition?.wells ?? {};
	const fw = def.wells;
	const names = Object.keys(fw);
	const drift = names.filter(
		(n) => bw[n]?.x !== fw[n].x || bw[n]?.y !== fw[n].y || bw[n]?.z !== fw[n].z
	);
	console.log(
		drift.length
			? `READBACK MISMATCH on ${drift.length} well(s): ${drift.join(', ')}`
			: `readback OK — all ${names.length} wells match the file exactly`
	);

	await mongoose.disconnect();
	if (drift.length) process.exit(1);
}

main().catch(async (e) => {
	console.error(e);
	try {
		await mongoose.disconnect();
	} catch {}
	process.exit(1);
});
