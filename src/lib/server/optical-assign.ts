/**
 * Assign an assay as optical-confirmation validation cartridges.
 *
 * One code path for the page action, the API and scripts. For each barcode
 * (scanned) — or `count` generated barcodes — this creates an
 * OpticalTestCartridge whose `bcode` is a FROZEN SNAPSHOT of the assay's BCODE
 * at assign time, and writes/adopts the cartridge_records doc in the exact
 * shape a RAN cartridge carries (full assay embedded) so the device can run it
 * on scan. Later edits to the source assay never change an assigned cartridge.
 *
 * Existing records (2026-09-10, per Jacob): a barcode that already exists as a
 * MANUFACTURING-state cartridge (backing, wax_filled, …) is a physical cart
 * off the line that is fine to run optics on. It is ADOPTED — the optical link
 * is written onto it, its status moves to `linked` with the old status kept in
 * `priorStatus`, and its manufacturing lineage (backing/wax/reagent blocks,
 * checkpoints.created, reagentChain) is left untouched. Only a record that has
 * already RUN (device readings / run-lifecycle status) or is linked to a
 * different assay is refused.
 */
import {
	AssayDefinition,
	OpticalTestCartridge,
	CartridgeGroup,
	CartridgeRecord,
	AuditLog,
	generateId
} from '$lib/server/db';
import { nextGroupColor } from '$lib/server/optical-constants';

export interface AssignOpticalOpts {
	assayId: string;
	barcodes?: string[];
	count?: number;
	groupName?: string;
	notes?: string;
	user: { _id: string; username: string };
}

export interface AssignOpticalResult {
	success: true;
	assay: { _id: string; skuCode: string; name: string; version: number };
	bcodeSteps: number;
	created: { _id: string; barcode: string; serialNumber: string }[];
	createdCount: number;
	/** Subset of `created` that were existing manufacturing cartridges taken over. */
	adopted: { barcode: string; priorStatus: string }[];
	skipped: { barcode: string; reason: string }[];
	/** The analysis group (Analysis Groups page) the batch was assigned into, if named. */
	groupId: string | null;
}

export interface AssignOpticalError {
	error: string;
	status: number;
}

/** Statuses that mean the cartridge has already been through a run. */
const RUN_LIFECYCLE = new Set(['underway', 'completed', 'cancelled', 'scrapped']);

export async function assignOpticalCartridges(
	opts: AssignOpticalOpts
): Promise<AssignOpticalResult | AssignOpticalError> {
	const assayId = (opts.assayId ?? '').toString().trim();
	if (!assayId) return { error: 'assayId is required', status: 400 };

	// Load the source assay and verify it carries a runnable BCODE.
	const assay = await AssayDefinition.findById(assayId).lean();
	if (!assay) return { error: `Assay "${assayId}" not found`, status: 404 };
	const BCODE = (assay as any).BCODE;
	if (!BCODE || !Array.isArray(BCODE.code) || BCODE.code.length === 0) {
		return { error: `Assay "${assayId}" has no runnable BCODE (deviceParams + code[])`, status: 400 };
	}

	// Resolve the target barcodes: explicit scanned list, or generate `count`.
	const operator = { _id: opts.user._id, username: opts.user.username };
	const now = new Date();
	let barcodes: string[] = Array.isArray(opts.barcodes)
		? [...new Set<string>(opts.barcodes.map((b) => String(b).trim()).filter(Boolean))]
		: [];
	const count = Number(opts.count);
	if (barcodes.length === 0) {
		if (!Number.isInteger(count) || count < 1 || count > 200) {
			return { error: 'Provide barcodes[] or a count between 1 and 200', status: 400 };
		}
		// Deterministic, human-readable barcode/serial off the assay id.
		barcodes = Array.from({ length: count }, (_, i) => `OPT-${assayId}-${String(i + 1).padStart(3, '0')}`);
	}

	// Optional group: the Group box on the assign form IS the analysis group
	// (2026-09-10, per Jacob — no batch-vs-cohort distinction). Find or create the
	// same-named 'optical_analysis' group; the assigned barcodes join its
	// cartridgeIds below, so it shows up on Analysis Groups the moment the batch
	// is assigned. (The old 'assign_batch' purpose is retired; see
	// scripts/unify-optical-groups.ts for the one-time fold.)
	let groupId: string | undefined;
	const groupName = (opts.groupName ?? '').toString().trim();
	if (groupName) {
		const existing = await CartridgeGroup.findOne({
			name: groupName,
			purpose: 'optical_analysis',
			archivedAt: null
		})
			.select('_id')
			.lean();
		if (existing) groupId = (existing as any)._id;
		else {
			const usedColors = (
				await CartridgeGroup.find({ purpose: 'optical_analysis', archivedAt: null }).select('color').lean()
			).map((g: any) => g.color);
			const g = await CartridgeGroup.create({
				_id: generateId(),
				name: groupName,
				description: `Assigned batch — ${(assay as any).name ?? assayId}`,
				color: nextGroupColor(usedColors),
				purpose: 'optical_analysis',
				cartridgeIds: [],
				createdBy: opts.user._id
			});
			groupId = g._id;
		}
	}

	// The frozen snapshot — everything needed to run, copied onto each cartridge.
	const bcodeSnapshot = { deviceParams: BCODE.deviceParams ?? {}, code: BCODE.code };
	const assayRef = {
		_id: (assay as any)._id as string,
		skuCode: ((assay as any).skuCode ?? (assay as any)._id) as string,
		name: (assay as any).name as string,
		version: ((assay as any).versionHistory?.length ?? 0) as number
	};

	// Serial numbers in the runnable format actual ran cartridges use: `${assayId}-run-${N}`.
	const checkpoint = { who: opts.user.username, when: now.toISOString(), where: { city_name: 'Houston' } };
	const expirationDate = '2030' + now.toISOString().slice(4);

	// The full assay (incl. BCODE) is embedded on each cartridge so the device has
	// the runnable program at scan time — this is what a ran cartridge carries.
	// The device runs cartridge.assay.BCODE directly off this doc; no experiment
	// arm is needed (the arm is the research app's org structure, not a run gate).
	const fullAssay = JSON.parse(JSON.stringify(assay));
	const armName = `BIMS Optical — ${(assay as any).name ?? assayId}`;

	// Serial sequence: continue numbering from existing optical cartridges. Avoids
	// the generated_barcodes counter (its unique `barcode` index rejects the null
	// upsert-insert with E11000).
	const baseSeq = await CartridgeRecord.countDocuments({ assayCategory: 'optical_test' });

	const created: AssignOpticalResult['created'] = [];
	const adopted: AssignOpticalResult['adopted'] = [];
	const skipped: AssignOpticalResult['skipped'] = [];
	let idx = 0;

	for (const barcode of barcodes) {
		idx += 1;
		const serialNumber = `${assayId}-run-${baseSeq + idx}`;
		// Idempotency guard: one optical cartridge per barcode (the scan IS the identity).
		const dup = await OpticalTestCartridge.findOne({ barcode }).lean();
		if (dup) {
			skipped.push({ barcode, reason: 'optical cartridge with this barcode already exists' });
			continue;
		}

		// An existing record is adopted if it has never run and isn't someone
		// else's assay; a record that already ran is never clobbered.
		const existingCR = (await CartridgeRecord.findById(barcode)
			.select('assayCategory assayId status serialNumber name expirationDate rawData.readings')
			.lean()) as any;
		const isOptical = existingCR?.assayCategory === 'optical_test';
		if (existingCR && !isOptical) {
			const ran =
				(Array.isArray(existingCR.rawData?.readings) && existingCR.rawData.readings.length > 0) ||
				RUN_LIFECYCLE.has(existingCR.status);
			if (ran) {
				skipped.push({ barcode, reason: `already ran (status ${existingCR.status}) — cannot be re-assigned` });
				continue;
			}
			if (existingCR.assayId && existingCR.assayId !== assayId) {
				skipped.push({ barcode, reason: `already linked to assay ${existingCR.assayId}` });
				continue;
			}
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
			notes: (opts.notes ?? '').toString().trim() || `Optical confirmation assay ${assayId}`,
			isActive: true,
			usageLog: [
				{
					_id: generateId(),
					action: 'registered',
					newValue: assayId,
					notes: existingCR && !isOptical
						? `BCODE snapshotted at assignment — adopted manufacturing cartridge (was ${existingCR.status})`
						: 'BCODE snapshotted at assignment',
					performedBy: operator,
					performedAt: now
				}
			],
			createdBy: opts.user._id
		});

		// The optical link, in the exact shape a RAN cartridge carries: the FULL
		// assay (incl. BCODE) embedded as `assay`, plus program/experiment/arm
		// linkage. The device reads cartridge.assay.BCODE to run; brevitest-cloud
		// later writes back underway/completed + device/rawData.
		const link: Record<string, unknown> = {
			assay: fullAssay,
			assayId: assayRef._id,
			assayName: assayRef.name,
			program: 'Run Cartridge',
			experiment: 'Run Cartridge',
			arm: armName,
			status: 'linked',
			statusUpdatedOn: now.toISOString(),
			used: false,
			// BIMS optical-validation tags + cross-ref
			assayCategory: 'optical_test',
			opticalTestCartridgeId: _id,
			assayLoaded: {
				assay: { _id: assayRef._id, name: assayRef.name, skuCode: assayRef.skuCode },
				loadedAt: now,
				recordedAt: now
			}
		};

		if (existingCR && !isOptical) {
			// ADOPT: touch only the link fields; the manufacturing record stays whole.
			await CartridgeRecord.updateOne(
				{ _id: barcode },
				{
					$set: {
						...link,
						priorStatus: existingCR.status ?? '',
						'checkpoints.linked': checkpoint,
						...(existingCR.serialNumber ? {} : { serialNumber }),
						...(existingCR.name ? {} : { name: serialNumber }),
						...(existingCR.expirationDate ? {} : { expirationDate })
					}
				}
			);
			adopted.push({ barcode, priorStatus: existingCR.status ?? '' });
		} else {
			// Fresh (or re-tagging an optical record): the full run-cartridge shape.
			await CartridgeRecord.findByIdAndUpdate(
				barcode,
				{
					$set: {
						...link,
						serialNumber,
						name: serialNumber,
						priorStatus: '',
						quantity: 0,
						expirationDate,
						validationErrors: [],
						reagentChain: [],
						checkpoints: { created: checkpoint, linked: checkpoint },
						folderId: ''
					},
					$setOnInsert: { _id: barcode }
				},
				{ upsert: true, new: true, setDefaultsOnInsert: true }
			);
		}

		created.push({ _id, barcode, serialNumber });
	}

	// The assigned barcodes join the group's cohort (cartridge_records._id IS the
	// barcode). Fresh assignments belong to no other group, so the one-group-per-
	// cartridge rule of saveGroup holds without a $pull here.
	if (groupId && created.length > 0) {
		await CartridgeGroup.updateOne(
			{ _id: groupId },
			{ $addToSet: { cartridgeIds: { $each: created.map((c) => c.barcode) } } }
		);
	}

	if (created.length > 0) {
		await AuditLog.create({
			tableName: 'optical_test_cartridges',
			recordId: 'batch',
			action: 'CREATE',
			newData: {
				assayId,
				count: created.length,
				groupId: groupId ?? null,
				barcodes: created.map((c) => c.barcode),
				adopted
			},
			changedBy: opts.user._id,
			changedAt: now,
			reason: 'Assign optical-confirmation validation cartridges (BCODE snapshot)'
		});
	}

	return {
		success: true,
		assay: assayRef,
		bcodeSteps: BCODE.code.length,
		created,
		createdCount: created.length,
		adopted,
		skipped,
		groupId: groupId ?? null
	};
}
