/**
 * Read-only diagnostic: surveys every assay in mongo and characterizes its
 * shape. Flags divergences between assays created in BIMS vs. those imported
 * from the legacy system.
 *
 * Does not write anything.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) { console.error('MONGODB_URI env var not set'); process.exit(1); }

function describe(val: unknown): string {
	if (val === null) return 'null';
	if (val === undefined) return 'undefined';
	if (Array.isArray(val)) return `array[${val.length}]`;
	if (val instanceof Date) return 'Date';
	if (Buffer.isBuffer(val)) return `Buffer(${val.length})`;
	if (val && typeof val === 'object' && (val as any)._bsontype === 'Binary') return `Binary(${(val as any).buffer?.length ?? '?'})`;
	return typeof val;
}

function keysOf(obj: Record<string, unknown>): string[] {
	return Object.keys(obj).sort();
}

async function main() {
	await mongoose.connect(MONGODB_URI!);
	const db = mongoose.connection.db!;
	const col = db.collection('assay_definitions');

	const all = await col.find({}).toArray();
	console.log(`=== ${all.length} assay_definitions total ===\n`);

	// Per-doc summary
	const perDoc = all.map((a) => {
		const keys = keysOf(a);
		const reagents = Array.isArray(a.reagents) ? a.reagents : [];
		const versions = Array.isArray(a.versionHistory) ? a.versionHistory : [];
		return {
			_id: String(a._id),
			name: a.name ?? null,
			skuCode: a.skuCode ?? null,
			assayId: a.assayId ?? null,
			isActive: a.isActive ?? null,
			createdAt: a.createdAt ?? null,
			updatedAt: a.updatedAt ?? null,
			// Shape markers
			keys,
			keyCount: keys.length,
			topLevelFields: keys,
			bcodeType: describe(a.bcode),
			bcodeLength: a.bcodeLength ?? null,
			checksum: a.checksum ?? null,
			duration: a.duration ?? null,
			reagentCount: reagents.length,
			reagentSampleKeys: reagents.length > 0 ? keysOf(reagents[0]) : [],
			firstReagentSubCount: reagents.length > 0 && Array.isArray(reagents[0].subComponents) ? reagents[0].subComponents.length : 0,
			versionCount: versions.length,
			// Legacy markers
			hasMetadata: a.metadata != null,
			metadataKeys: a.metadata && typeof a.metadata === 'object' ? keysOf(a.metadata as any) : [],
			hasCorrections: Array.isArray(a.corrections) && a.corrections.length > 0,
			hasLockedAt: !!a.lockedAt,
			hasShelfLifeDays: a.shelfLifeDays != null,
			hasBomCostOverride: a.bomCostOverride != null,
			hasUseSingleCost: a.useSingleCost != null,
			hasDescription: a.description != null,
			// Detect objectId-like vs nanoid _id
			idShape: /^[0-9a-f]{24}$/.test(String(a._id)) ? 'hex24(ObjectId-like)' : (typeof a._id === 'string' ? 'string' : 'other'),
			// Extra/unknown top-level keys outside the current schema
			unknownTopLevel: keys.filter(k => ![
				'_id','assayId','name','description','skuCode','duration','bcode','bcodeLength','checksum',
				'isActive','shelfLifeDays','bomCostOverride','useSingleCost','reagents','versionHistory',
				'lockedAt','lockedBy','corrections','metadata','createdAt','updatedAt','__v'
			].includes(k))
		};
	});

	// Bucket by key-set signature
	const bySignature = new Map<string, typeof perDoc>();
	for (const d of perDoc) {
		const sig = d.keys.join('|');
		const arr = bySignature.get(sig) ?? [];
		arr.push(d);
		bySignature.set(sig, arr);
	}

	console.log(`=== ${bySignature.size} distinct top-level key-signatures ===\n`);
	let idx = 0;
	for (const [sig, members] of bySignature) {
		idx++;
		console.log(`--- Signature #${idx} (${members.length} doc${members.length !== 1 ? 's' : ''}) ---`);
		console.log(`keys: ${sig.split('|').join(', ')}`);
		console.log('members:');
		for (const m of members) {
			console.log(`  • ${m._id}  "${m.name}"  sku=${m.skuCode}  idShape=${m.idShape}  createdAt=${m.createdAt?.toISOString?.() ?? m.createdAt ?? '—'}`);
		}
		// Show a canonical member in full
		const first = members[0];
		console.log(`  sample shape:`);
		console.log(`    bcode=${first.bcodeType}  bcodeLength=${first.bcodeLength}  checksum=${first.checksum}  duration=${first.duration}`);
		console.log(`    reagents=${first.reagentCount}  firstReagentKeys=[${first.reagentSampleKeys.join(', ')}]  firstReagentSubs=${first.firstReagentSubCount}`);
		console.log(`    versionHistory=${first.versionCount}  metadata=${first.hasMetadata ? `{${first.metadataKeys.join(', ')}}` : 'none'}`);
		console.log(`    unknownTopLevelKeys: ${first.unknownTopLevel.length > 0 ? first.unknownTopLevel.join(', ') : 'none'}`);
		console.log('');
	}

	// Per-doc table for quick scanning
	console.log('=== per-doc summary table ===');
	for (const d of perDoc) {
		console.log(`${d._id}  ${String(d.name).padEnd(30)} sku=${String(d.skuCode).padEnd(14)} bcode=${d.bcodeType.padEnd(14)} reag=${String(d.reagentCount).padStart(2)} ver=${String(d.versionCount).padStart(2)} idShape=${d.idShape}`);
	}

	// Spot-check reagent shape consistency (cheapest signal for "different" assays)
	console.log('\n=== reagent sub-shape signatures ===');
	const reagSig = new Map<string, number>();
	for (const a of all) {
		if (!Array.isArray(a.reagents)) continue;
		for (const r of a.reagents) {
			const sig = keysOf(r).join('|');
			reagSig.set(sig, (reagSig.get(sig) ?? 0) + 1);
		}
	}
	for (const [sig, count] of reagSig) {
		console.log(`  (${count}x) ${sig.split('|').join(', ')}`);
	}

	// Dump one raw doc from each signature for full-depth visibility (truncating bcode)
	console.log('\n=== one raw example per signature (bcode elided) ===');
	for (const [, members] of bySignature) {
		const ex = await col.findOne({ _id: members[0]._id });
		if (!ex) continue;
		const cp: any = { ...ex };
		if (cp.bcode) cp.bcode = `<${describe(cp.bcode)}>`;
		if (cp.versionHistory) {
			cp.versionHistory = cp.versionHistory.map((v: any) => ({ ...v, previousBcode: v.previousBcode ? `<${describe(v.previousBcode)}>` : null }));
		}
		console.log(`\n--- ${cp._id} "${cp.name}" ---`);
		console.log(JSON.stringify(cp, null, 2));
	}

	await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
