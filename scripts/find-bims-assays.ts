/**
 * Read-only: find any assay_definitions that look BIMS-created (non-legacy).
 * Legacy markers: has BCODE (uppercase), hidden, protected, skuCode=null, _id = A########.
 * A BIMS-created doc is one missing these markers (typically has metadata.instructions,
 * an ASSAY-... or nanoid skuCode, or a non-A# _id).
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const URI = process.env.MONGODB_URI;
if (!URI) { console.error('MONGODB_URI missing'); process.exit(1); }

async function main() {
	await mongoose.connect(URI!);
	const col = mongoose.connection.db!.collection('assay_definitions');

	const idRx = /^A[0-9A-F]{7}$/;

	const all = await col.find({}).project({ _id: 1, name: 1, skuCode: 1, hidden: 1, protected: 1, BCODE: 1, metadata: 1, bcode: 1, createdAt: 1 }).toArray();

	const bimsCandidates: any[] = [];
	for (const a of all) {
		const idLooksLegacy = idRx.test(String(a._id));
		const hasBcodeUpper = a.BCODE != null;
		const hasMetadata = a.metadata != null;
		const hasSkuCode = a.skuCode != null && a.skuCode !== '';
		const hasHidden = a.hidden != null;
		const hasProtected = a.protected != null;

		const nonLegacySignals = [
			!idLooksLegacy,
			!hasBcodeUpper,
			hasMetadata,
			hasSkuCode,
			!hasHidden,
			!hasProtected,
			a.bcode != null // lowercase Buffer written by schema-matching code
		].filter(Boolean).length;

		if (nonLegacySignals > 0) {
			bimsCandidates.push({
				_id: a._id,
				name: a.name,
				skuCode: a.skuCode ?? null,
				idLooksLegacy,
				hasBcodeUpper,
				hasMetadata,
				hasHidden,
				hasProtected,
				hasBcodeLower: a.bcode != null,
				createdAt: a.createdAt
			});
		}
	}

	console.log(`${all.length} total assay_definitions scanned.`);
	console.log(`${bimsCandidates.length} with any non-legacy signals:\n`);
	for (const c of bimsCandidates) {
		console.log(JSON.stringify(c, null, 2));
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
