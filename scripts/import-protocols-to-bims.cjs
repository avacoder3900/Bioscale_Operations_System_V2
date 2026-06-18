/**
 * NATIVE-CALIBRATION-SYSTEM PRD 1 — import the current wax/reagent .py protocols
 * from the lab-Mac Opentrons folder into BIMS (opentrons_protocols.fileContent) so
 * BIMS is the source of truth and "Re-upload to robot" can bundle tuned labware.
 *
 * Run:  node scripts/import-protocols-to-bims.cjs
 * Reads MONGODB_URI from the real .env. Portable via $HOME (no hardcoded protocol dir).
 * Idempotent: upserts the active protocol per processType by file hash.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

function loadUri() {
	const envPath = `${process.env.HOME}/Bioscale_Operations_System_V2/.env`;
	const env = fs.readFileSync(envPath, 'utf8');
	const line = env.split('\n').find((l) => l.startsWith('MONGODB_URI='));
	return line.slice('MONGODB_URI='.length).trim().replace(/^["']|["']$/g, '');
}

// Find the newest matching .py under the Opentrons protocols dir.
function findProtocol(nameMatch) {
	const base = `${process.env.HOME}/Library/Application Support/Opentrons/protocols`;
	const hits = [];
	for (const dir of fs.readdirSync(base)) {
		const src = path.join(base, dir, 'src');
		if (!fs.existsSync(src)) continue;
		for (const f of fs.readdirSync(src)) {
			if (f.endsWith('.py') && nameMatch.test(f)) {
				const fp = path.join(src, f);
				hits.push({ fp, name: f, mtime: fs.statSync(fp).mtimeMs });
			}
		}
	}
	hits.sort((a, b) => b.mtime - a.mtime);
	return hits[0] ?? null;
}

(async () => {
	await mongoose.connect(loadUri(), { serverSelectionTimeoutMS: 60000 });
	const col = mongoose.connection.db.collection('opentrons_protocols');

	const targets = [
		{ processType: 'wax-filling', match: /Wax_Filling_GEN7/i },
		{ processType: 'reagent-filling', match: /Reagent_Filling_GEN7/i }
	];

	for (const t of targets) {
		const found = findProtocol(t.match);
		if (!found) { console.log(`✗ ${t.processType}: no matching .py found on disk`); continue; }
		const content = fs.readFileSync(found.fp, 'utf8');
		const hash = crypto.createHash('sha256').update(content).digest('hex');
		// Deactivate prior active rows for this type, then upsert this one active.
		await col.updateMany({ processType: t.processType, isActive: true }, { $set: { isActive: false } });
		const existing = await col.findOne({ processType: t.processType, fileHash: hash });
		if (existing) {
			await col.updateOne({ _id: existing._id }, { $set: { isActive: true, fileName: found.name, fileContent: content, updatedAt: new Date() } });
			console.log(`✓ ${t.processType}: re-activated existing (${found.name}, ${content.length} chars)`);
		} else {
			await col.insertOne({
				_id: 'op-' + crypto.randomBytes(8).toString('hex'),
				protocolName: found.name,
				version: 1,
				processType: t.processType,
				fileName: found.name,
				fileHash: hash,
				fileContent: content,
				isActive: true,
				uploadedBy: 'import-script',
				createdAt: new Date(),
				updatedAt: new Date()
			});
			console.log(`✓ ${t.processType}: imported ${found.name} (${content.length} chars)`);
		}
	}

	await mongoose.disconnect();
})();
