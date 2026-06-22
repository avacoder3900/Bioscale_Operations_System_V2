import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, AssayDefinition, OpticalTestCartridge, CartridgeGroup, CartridgeRecord, GeneratedBarcode, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';

// Assign an assay as an optical-confirmation validation cartridge.
//
// For each barcode (scanned) — or `count` generated barcodes — this creates an
// OpticalTestCartridge whose `bcode` is a FROZEN SNAPSHOT of the assay's BCODE
// at assign time. The cartridge document is therefore fully self-contained and
// runnable: scan it, read `bcode`, send to the SPU reader. Later edits to the
// source assay never change an already-assigned validation cartridge.
//
// Body: { assayId, barcodes?: string[], count?: number, groupName?: string, notes?: string }
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'cartridge:write');
	await connectDB();

	const body = await request.json();
	const assayId = (body.assayId ?? '').toString().trim();
	if (!assayId) return json({ error: 'assayId is required' }, { status: 400 });

	// Load the source assay and verify it carries a runnable BCODE.
	const assay = await AssayDefinition.findById(assayId).lean();
	if (!assay) return json({ error: `Assay "${assayId}" not found` }, { status: 404 });
	const BCODE = (assay as any).BCODE;
	if (!BCODE || !Array.isArray(BCODE.code) || BCODE.code.length === 0) {
		return json({ error: `Assay "${assayId}" has no runnable BCODE (deviceParams + code[])` }, { status: 400 });
	}

	// Resolve the target barcodes: explicit scanned list, or generate `count`.
	const operator = { _id: locals.user._id, username: locals.user.username };
	const now = new Date();
	let barcodes: string[] = Array.isArray(body.barcodes)
		? [...new Set<string>(body.barcodes.map((b: unknown) => String(b).trim()).filter(Boolean))]
		: [];
	const count = Number(body.count);
	if (barcodes.length === 0) {
		if (!Number.isInteger(count) || count < 1 || count > 200) {
			return json({ error: 'Provide barcodes[] or a count between 1 and 200' }, { status: 400 });
		}
		// Deterministic, human-readable barcode/serial off the assay id.
		barcodes = Array.from({ length: count }, (_, i) => `OPT-${assayId}-${String(i + 1).padStart(3, '0')}`);
	}

	// Optional group: create/lookup a CartridgeGroup by name.
	let groupId: string | undefined;
	const groupName = (body.groupName ?? '').toString().trim();
	if (groupName) {
		const existing = await CartridgeGroup.findOne({ name: groupName }).lean();
		if (existing) groupId = (existing as any)._id;
		else {
			const g = await CartridgeGroup.create({ _id: generateId(), name: groupName, createdBy: locals.user._id });
			groupId = g._id;
		}
	}

	// The frozen snapshot — everything needed to run, copied onto each cartridge.
	const bcodeSnapshot = { deviceParams: BCODE.deviceParams ?? {}, code: BCODE.code };
	const assayRef = {
		_id: (assay as any)._id,
		skuCode: (assay as any).skuCode ?? (assay as any)._id,
		name: (assay as any).name,
		version: (assay as any).versionHistory?.length ?? 0
	};

	// Serial numbers in the research-runnable format: `${assayId}-${batchKey}-${index}`.
	// batchKey is an 11-digit monotonic batch counter (per assay); index is the
	// 3-digit position within this assign call.
	const batchDoc = await GeneratedBarcode.findOneAndUpdate(
		{ prefix: `OPT-${assayId}` },
		{ $inc: { sequence: 1 } },
		{ upsert: true, new: true, setDefaultsOnInsert: true }
	);
	const batchKey = String((batchDoc as any)?.sequence ?? 1).padStart(11, '0');
	const checkpoint = { who: locals.user.username, when: now.toISOString() };

	const created: { _id: string; barcode: string; serialNumber: string }[] = [];
	const skipped: { barcode: string; reason: string }[] = [];
	let idx = 0;

	for (const barcode of barcodes) {
		idx += 1;
		const serialNumber = `${assayId}-${batchKey}-${String(idx).padStart(3, '0')}`;
		// Idempotency guard: one optical cartridge per barcode (the scan IS the identity).
		const dup = await OpticalTestCartridge.findOne({ barcode }).lean();
		if (dup) { skipped.push({ barcode, reason: 'optical cartridge with this barcode already exists' }); continue; }

		// Don't clobber a real product cartridge that happens to share this id.
		const existingCR = await CartridgeRecord.findById(barcode).select('assayCategory status').lean();
		if (existingCR && (existingCR as any).assayCategory !== 'optical_test') {
			skipped.push({ barcode, reason: 'a non-optical cartridge already exists with this barcode' });
			continue;
		}

		const _id = generateId();
		await OpticalTestCartridge.create({
			_id,
			barcode,
			serialNumber,
			assay: assayRef,
			bcode: bcodeSnapshot,
			bcodeSnapshotAt: now,
			duration: (assay as any).duration,
			groupId,
			status: 'available',
			notes: (body.notes ?? '').toString().trim() || `Optical confirmation assay ${assayId}`,
			isActive: true,
			usageLog: [{
				_id: generateId(),
				action: 'registered',
				newValue: assayId,
				notes: 'BCODE snapshotted at assignment',
				performedBy: operator,
				performedAt: now
			}],
			createdBy: locals.user._id
		});

		// Register it in cartridge_records (_id = scanned barcode) with the FLAT
		// runnable shape the device reads (mirrors research seed cartridges):
		// top-level assayId/assayName/serialNumber/checkpoints/used/etc. The device
		// resolves assayId -> the assay's BCODE program at scan time. Upsert: create
		// if new, tag if it was already an optical cartridge_records doc.
		await CartridgeRecord.findByIdAndUpdate(
			barcode,
			{
				$set: {
					// flat runnable fields
					assayId: assayRef._id,
					assayName: assayRef.name,
					serialNumber,
					name: serialNumber,
					status: 'linked',
					statusUpdatedOn: now.toISOString(),
					used: false,
					validationErrors: [],
					checkpoints: { created: checkpoint, linked: checkpoint },
					// BIMS optical-validation tags + cross-ref
					assayCategory: 'optical_test',
					opticalTestCartridgeId: _id,
					assayLoaded: { assay: { _id: assayRef._id, name: assayRef.name, skuCode: assayRef.skuCode }, loadedAt: now, recordedAt: now }
				},
				$setOnInsert: { _id: barcode }
			},
			{ upsert: true, new: true, setDefaultsOnInsert: true }
		);

		created.push({ _id, barcode, serialNumber });
	}

	if (created.length > 0) {
		await AuditLog.create({
			tableName: 'optical_test_cartridges',
			recordId: 'batch',
			action: 'CREATE',
			newData: { assayId, count: created.length, groupId: groupId ?? null, barcodes: created.map((c) => c.barcode) },
			changedBy: locals.user._id,
			changedAt: now,
			reason: 'Assign optical-confirmation validation cartridges (BCODE snapshot)'
		});
	}

	return json({
		success: true,
		assay: assayRef,
		bcodeSteps: BCODE.code.length,
		created,
		createdCount: created.length,
		skipped,
		groupId: groupId ?? null
	});
};
