import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, AssayDefinition, OpticalTestCartridge, CartridgeGroup, CartridgeRecord, GeneratedBarcode, Experiment, AuditLog, generateId } from '$lib/server/db';
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

	// Serial numbers in the runnable format actual ran cartridges use: `${assayId}-run-${N}`.
	const checkpoint = { who: locals.user.username, when: now.toISOString(), where: { city_name: 'Houston' } };
	const expirationDate = '2030' + now.toISOString().slice(4);

	// The full assay (incl. BCODE) is embedded on each cartridge so the device has
	// the runnable program at scan time — this is what a ran cartridge carries.
	const fullAssay = JSON.parse(JSON.stringify(assay));

	// Cartridges run via the "run-cartridge" experiment. Use/create an arm for this
	// assay so brevitest-cloud picks them up; mirror its program/experiment/arm onto
	// each cartridge. Arm is clearly labelled as BIMS-created for traceability.
	const RUN_EXPERIMENT_ID = 'run-cartridge';
	const armName = `BIMS Optical — ${(assay as any).name ?? assayId}`;
	const runExp: any = await Experiment.findById(RUN_EXPERIMENT_ID);

	const created: { _id: string; barcode: string; serialNumber: string }[] = [];
	const skipped: { barcode: string; reason: string }[] = [];
	const armPush: { barcode: string; status: string; quantity: number }[] = [];
	let idx = 0;

	for (const barcode of barcodes) {
		idx += 1;
		const runSeq = await GeneratedBarcode.findOneAndUpdate(
			{ prefix: 'run-cartridge' },
			{ $inc: { sequence: 1 } },
			{ upsert: true, new: true, setDefaultsOnInsert: true }
		);
		const serialNumber = `${assayId}-run-${(runSeq as any)?.sequence ?? idx}`;
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

		// Write the cartridge_records doc in the exact shape a RAN cartridge carries:
		// the FULL assay (incl. BCODE) embedded as `assay`, plus program/experiment/arm
		// linkage to the run-cartridge experiment. The device reads cartridge.assay.BCODE
		// to run; brevitest-cloud later writes back underway/completed + device/rawData.
		await CartridgeRecord.findByIdAndUpdate(
			barcode,
			{
				$set: {
					assay: fullAssay,            // full embedded assay WITH BCODE — what the device runs
					assayId: assayRef._id,
					assayName: assayRef.name,
					program: 'Run Cartridge',
					experiment: 'Run Cartridge',
					arm: armName,
					serialNumber,
					name: serialNumber,
					status: 'linked',
					priorStatus: '',
					statusUpdatedOn: now.toISOString(),
					quantity: 0,
					expirationDate,
					used: false,
					validationErrors: [],
					reagentChain: [],
					checkpoints: { created: checkpoint, linked: checkpoint },
					folderId: '',
					// BIMS optical-validation tags + cross-ref
					assayCategory: 'optical_test',
					opticalTestCartridgeId: _id,
					assayLoaded: { assay: { _id: assayRef._id, name: assayRef.name, skuCode: assayRef.skuCode }, loadedAt: now, recordedAt: now }
				},
				$setOnInsert: { _id: barcode }
			},
			{ upsert: true, new: true, setDefaultsOnInsert: true }
		);

		armPush.push({ barcode, status: 'linked', quantity: 0 });
		created.push({ _id, barcode, serialNumber });
	}

	// Add the cartridges to the run-cartridge experiment's arm so the runner picks
	// them up. Reuse the BIMS arm for this assay if present, else create it.
	if (armPush.length > 0 && runExp) {
		const arms: any[] = Array.isArray(runExp.arms) ? runExp.arms : [];
		let arm = arms.find((a) => a.name === armName);
		if (!arm) {
			arm = { name: armName, description: 'BIMS optical-confirmation validation cartridges', assayId, assayName: (assay as any).name, splitQuantity: false, cartridges: [] };
			arms.push(arm);
		}
		arm.cartridges = [...(arm.cartridges ?? []), ...armPush];
		runExp.arms = arms;
		runExp.statusUpdatedOn = now.toISOString();
		runExp.markModified('arms');
		await runExp.save();
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
