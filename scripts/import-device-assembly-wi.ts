/**
 * Import (or re-import) the Device Assembly Work Instruction from a .docx.
 *
 *   npx tsx scripts/import-device-assembly-wi.ts "/path/to/WIMF With Sections.docx" [username]
 *
 * Images are stored in Mongo (work_instruction_images) because this script
 * runs outside SvelteKit and cannot reach the R2 worker config. The web UI
 * upload (Manufacturing → Device Assembly WI → Upload .docx) uses R2 first.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { importDeviceAssemblyWI, mongoImageStore, DEVICE_WI_DOCUMENT_NUMBER } from '../src/lib/server/services/device-assembly-wi';
import { DeviceAssemblyWI, User } from '../src/lib/server/db/models/index.js';

const file = process.argv[2];
const username = process.argv[3] ?? 'system';
if (!file) {
	console.error('usage: npx tsx scripts/import-device-assembly-wi.ts <file.docx> [username]');
	process.exit(1);
}
if (!process.env.MONGODB_URI) {
	console.error('MONGODB_URI is not set');
	process.exit(1);
}

await mongoose.connect(process.env.MONGODB_URI);
try {
	const user = (await User.findOne({ username }).select('_id username').lean()) as any;
	const actor = user ? { _id: String(user._id), username: user.username } : { _id: 'system', username };
	if (!user) console.warn(`user "${username}" not found — recording the import as "${username}" without a user id`);

	const existing = (await DeviceAssemblyWI.findOne({ documentNumber: DEVICE_WI_DOCUMENT_NUMBER }).select('_id currentVersion').lean()) as any;
	const buffer = fs.readFileSync(file);
	const res = await importDeviceAssemblyWI(
		{ buffer, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', originalName: path.basename(file) },
		actor,
		mongoImageStore(existing?._id ?? null, actor.username)
	);
	const steps = res.parsed.sections.reduce((n, s) => n + s.steps.length, 0);
	console.log(`Imported ${path.basename(file)} → ${DEVICE_WI_DOCUMENT_NUMBER} v${res.version} (${res.wiId})`);
	console.log(`  sections: ${res.parsed.sections.length}, steps: ${steps}, images: ${res.parsed.imageCount}`);
	for (const s of res.parsed.sections) console.log(`  - [${s.type}] #${s.number} ${s.title}: ${s.steps.length} steps`);
	if (res.unresolved.length) console.log(`  part numbers not in catalog: ${res.unresolved.join(', ')}`);
	if (res.parsed.warnings.length) console.log(`  warnings:\n    ${res.parsed.warnings.join('\n    ')}`);
} finally {
	await mongoose.disconnect();
}
