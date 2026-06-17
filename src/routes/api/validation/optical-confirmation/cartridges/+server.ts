import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, mongoose, AuditLog } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';

// Status check: is the cartridge_records doc for this barcode "linked" + which assay/serial?
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();
	const barcode = url.searchParams.get('barcode')?.trim();
	if (!barcode) return json({ exists: false });
	const col = mongoose.connection.db.collection('cartridge_records');
	const c = await col.findOne({ _id: barcode as any }, { projection: { assayId: 1, status: 1, serialNumber: 1, experiment: 1, arm: 1 } });
	if (!c) return json({ exists: false });
	return json({ exists: true, ...c });
};

// Add cartridges to an experiment → arm (brevitest-research add-cartridge-to-arm), which is what makes
// the SPU/brevitest-cloud run AND complete the test. Writes the full research/SPU cartridge shape onto
// cartridge_records (status:'linked' + assayId + folderId/program/experiment/arm + serialNumber +
// checkpoints), pushes refs into the arm, and bumps the experiment's nextSerialNumber.
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'cartridge:write');
	await connectDB();

	const body = await request.json();
	const experimentId = (body.experimentId ?? '').toString().trim();
	const armIndex = Number(body.armIndex);
	const rawList: string[] = Array.isArray(body.barcodes) ? body.barcodes : body.barcode ? [body.barcode] : [];
	const barcodes = [...new Set(rawList.map((b) => String(b).trim()).filter(Boolean))];

	if (!experimentId) return json({ error: 'Select an experiment' }, { status: 400 });
	if (!Number.isInteger(armIndex) || armIndex < 0) return json({ error: 'Select an arm' }, { status: 400 });
	if (barcodes.length === 0) return json({ error: 'Provide at least one barcode' }, { status: 400 });

	const db = mongoose.connection.db;
	const dbName = db.databaseName;
	const expCol = db.collection('experiments');
	const crCol = db.collection('cartridge_records');

	const exp: any = await expCol.findOne({ _id: experimentId as any });
	if (!exp) return json({ error: 'Experiment not found' }, { status: 400 });
	const arm = exp.arms?.[armIndex];
	if (!arm) return json({ error: 'Arm not found on experiment' }, { status: 400 });

	const batchKey = String(exp.folderId ?? '').slice(0, 11);
	let nextSerial = Number(exp.nextSerialNumber ?? 0);

	const now = new Date();
	const nowIso = now.toISOString();
	const who = (locals.user as any).username || (locals.user as any).email || locals.user._id;
	const checkpoint = { who, when: nowIso, where: { city_name: 'Houston' } };
	const expirationDate = new Date(now.getTime() + 4 * 365 * 24 * 3600 * 1000).toISOString();

	const updated: { barcode: string; serialNumber: string }[] = [];
	const skipped: { barcode: string; reason: string }[] = [];
	const armPush: any[] = [];

	for (const barcode of barcodes) {
		const index = nextSerial % 1000;
		const serialNumber = `${arm.assayId}-${batchKey}-${String(index).padStart(3, '0')}`;
		try {
			await crCol.updateOne(
				{ _id: barcode as any },
				{
					$set: {
						status: 'linked',
						statusUpdatedOn: nowIso,
						assayId: arm.assayId,
						assayName: arm.assayName ?? '',
						folderId: exp.folderId,
						program: exp.program,
						experiment: exp.name,
						arm: arm.name,
						serialNumber,
						checkpoints: { created: checkpoint, linked: checkpoint },
						quantity: 0,
						expirationDate,
						assayCategory: 'optical_test'
					},
					$setOnInsert: { validationErrors: [], photos: [], reagentChain: [], corrections: [], photoSequence: 0 }
				},
				{ upsert: true }
			);
			armPush.push({ barcode, status: 'linked', quantity: 0 });
			updated.push({ barcode, serialNumber });
			nextSerial = index + 1;
		} catch (err) {
			skipped.push({ barcode, reason: err instanceof Error ? err.message : 'update failed' });
		}
	}

	// Register the cartridges on the arm + advance the experiment's serial counter.
	if (armPush.length > 0) {
		await expCol.updateOne(
			{ _id: experimentId as any },
			{ $push: { [`arms.${armIndex}.cartridges`]: { $each: armPush } } as any, $set: { nextSerialNumber: nextSerial, statusUpdatedOn: nowIso } }
		);
	}

	const verified = updated.length
		? await crCol
				.find({ _id: { $in: updated.map((u) => u.barcode) as any } })
				.project({ _id: 1, status: 1, assayId: 1, serialNumber: 1, experiment: 1, arm: 1 })
				.toArray()
		: [];

	if (updated.length > 0) {
		await AuditLog.create({
			tableName: 'cartridge_records',
			recordId: experimentId,
			action: 'UPDATE',
			newData: { assayId: arm.assayId, experiment: exp.name, arm: arm.name, count: updated.length, barcodes: updated.map((u) => u.barcode) },
			changedBy: locals.user._id,
			changedAt: now,
			reason: 'Add cartridges to experiment arm (optical test) — research/SPU runnable shape'
		});
	}

	return json({
		success: true,
		dbName,
		updated: updated.length,
		skipped,
		verified: JSON.parse(JSON.stringify(verified)),
		assayId: arm.assayId,
		experiment: exp.name,
		arm: arm.name
	});
};
