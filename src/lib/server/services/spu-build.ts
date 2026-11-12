import { SpuBuild, SpuBucket, ReceivingLot, PartDefinition, AuditLog, InventoryTransaction, DeviceAssemblyMaterialPull, CartridgeRecord } from '$lib/server/db/models/index.js';
import { generateId } from '$lib/server/db/utils.js';
import { getDeviceAssemblyWI, findSection, findStep, type Actor } from './device-assembly-wi';
import { pullMaterialsForStep } from './device-assembly-wi-pulls';
import { resolveBucketId } from './bucket-service';
import {
	currentStep,
	bucketLabel,
	buildProgress,
	deducts,
	doneStepIds,
	findStepForPart,
	normalizeBucketCode,
	partsLeft,
	partsOf,
	scanKey,
	scannedKeys,
	sectionConfirmed,
	sectionsUsingPart,
	SLOT_HOLDING_STATUSES,
	tabLabel,
	type WiMaterial,
	type WiStep
} from '$lib/spu-build/progress';

// Building several SPUs at once (/spu/assembly-wi/build). Each SPU lives in
// its own bucket; scanning a bucket picks the build, and scanning the lot label
// on a parts bag deducts that part against the step of the picked build that
// still needs it. Deductions go through pullMaterialsForStep(), the same path
// as the WI page's manual pull form, so inventory counts, low-stock alerts and
// per-step pull history all stay in one place.

/** A failure whose message is written for the operator and safe to show. */
export class BuildError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BuildError';
	}
}

/** Who is building: the name they gave (or their badge's), and the account it is attributed to. */
export type BuildOperator = { name: string; user: Actor; badgeCode?: string | null };

export type BuildOutcome = { kind: 'ok' | 'warn'; message: string; buildId?: string };

const BOARD_COMPLETED_WINDOW_MS = 24 * 60 * 60 * 1000;

function operatorDoc(op: BuildOperator) {
	return { name: op.name, userId: op.user._id, username: op.user.username, badgeCode: op.badgeCode ?? null };
}

function warn(message: string): BuildOutcome {
	return { kind: 'warn', message };
}

function lotName(lot: any): string {
	return lot.lotNumber || lot.bagBarcode || lot.lotId || String(lot._id);
}

function partLabel(m: WiMaterial): string {
	return m.partNumber || m.name;
}

async function requireWi(): Promise<any> {
	const wi = await getDeviceAssemblyWI();
	if (!wi) throw new BuildError('Import the SPU Assembly Work Instruction before building.');
	return wi;
}

async function loadOpenBuild(buildId: string): Promise<any> {
	const build = await SpuBuild.findById(buildId).lean() as any;
	if (!build) throw new BuildError('That build no longer exists. Reload the page.');
	if (build.status === 'cancelled') throw new BuildError(`SPU ${build.buildNumber} was cancelled. Nothing recorded.`);
	if (build.status !== 'in_progress') throw new BuildError(`SPU ${build.buildNumber} is already complete. Nothing recorded.`);
	return build;
}

function sectionOrThrow(wi: any, sectionNumber: number): any {
	const section = findSection(wi, sectionNumber);
	if (!section) throw new BuildError('That section is no longer on the work instruction. Reload the page.');
	return section;
}

async function audit(action: string, build: { _id: string; buildNumber: number; bucketCode: string; bucketNumber?: number | null }, op: BuildOperator, data: Record<string, unknown>) {
	await AuditLog.create({
		_id: generateId(),
		tableName: 'spu_builds',
		recordId: String(build._id),
		action,
		newData: { operation: data.operation, buildNumber: build.buildNumber, bucket: bucketLabel(build), bucketCode: build.bucketCode, operatorName: op.name, ...data },
		changedAt: new Date(),
		changedBy: op.user.username
	});
}

// ── board ──────────────────────────────────────────────────────────────────

async function nextBucketNumber(): Promise<number> {
	const last = await SpuBucket.findOne({}).sort({ number: -1 }).select('number').lean() as any;
	return (last?.number ?? 0) + 1;
}

/** Builds on the board: every one in progress, plus those finished or cancelled in the last 24 h. And the bucket list. */
export async function loadBoard(): Promise<{ builds: any[]; nextBuildNumber: number; buckets: any[]; nextBucketNumber: number }> {
	const since = new Date(Date.now() - BOARD_COMPLETED_WINDOW_MS);
	const [builds, last, buckets, nextBucket] = await Promise.all([
		SpuBuild.find({
			$or: [
				{ status: 'in_progress' },
				{ status: 'completed', completedAt: { $gte: since } },
				{ status: 'cancelled', cancelledAt: { $gte: since } }
			]
		})
			.sort({ buildNumber: 1 })
			.lean(),
		SpuBuild.findOne({}).sort({ buildNumber: -1 }).select('buildNumber').lean() as any,
		SpuBucket.find({ active: true }).sort({ number: 1 }).select('number qrCode addedAt').lean(),
		nextBucketNumber()
	]);
	return {
		builds: JSON.parse(JSON.stringify(builds)),
		nextBuildNumber: (last?.buildNumber ?? 0) + 1,
		buckets: JSON.parse(JSON.stringify(buckets)),
		nextBucketNumber: nextBucket
	};
}

// ── buckets ────────────────────────────────────────────────────────────────

async function findBucket(code: string | null): Promise<any | null> {
	return code ? SpuBucket.findOne({ qrCode: code, active: true }).lean() : null;
}

/**
 * Register a bucket's QR code as the next bucket number ("Bucket 3"). A QR code
 * that is already a bucket just says which one; a code that is some other kind
 * of label (lot, part, cartridge, badge, cartridge-line tub) is refused.
 */
export async function registerBucket(input: { qrCode: string }, op: BuildOperator): Promise<BuildOutcome & { bucketId?: string; bucketNumber?: number }> {
	const raw = input.qrCode.trim();
	const qrCode = normalizeBucketCode(raw);
	if (!qrCode) throw new BuildError(`${raw || 'That'} doesn't look like a bucket QR code.`);
	const existing = await SpuBucket.findOne({ qrCode }).lean() as any;
	if (existing) return { kind: 'warn', message: `That QR code is already Bucket ${existing.number}.`, bucketId: String(existing._id), bucketNumber: existing.number };
	const what = await whatElseIsIt(raw);
	if (what) throw new BuildError(`${raw} is ${what}, not a bucket QR code. Nothing added.`);

	// number is unique: if two stations add a bucket at the same moment, the loser takes the next number.
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const number = await nextBucketNumber();
		try {
			const doc = await SpuBucket.create({
				_id: generateId(),
				number,
				qrCode,
				active: true,
				addedBy: { name: op.name, userId: op.user._id, username: op.user.username },
				addedAt: new Date()
			});
			await AuditLog.create({
				_id: generateId(),
				tableName: 'spu_buckets',
				recordId: String(doc._id),
				action: 'INSERT',
				newData: { operation: 'spu_bucket_register', number, qrCode, operatorName: op.name },
				changedAt: new Date(),
				changedBy: op.user.username
			});
			return { kind: 'ok', message: `QR code added as Bucket ${number}.`, bucketId: String(doc._id), bucketNumber: number };
		} catch (e: any) {
			if (e?.code !== 11000) throw e;
			const same = await SpuBucket.findOne({ qrCode }).lean() as any;
			if (same) return { kind: 'warn', message: `That QR code was just added as Bucket ${same.number}.`, bucketId: String(same._id), bucketNumber: same.number };
		}
	}
	throw new BuildError('Could not assign a bucket number. Try again.');
}

// ── start ──────────────────────────────────────────────────────────────────

/** Start the next SPU in a registered bucket (by SpuBucket id, or by its scanned QR code). */
export async function startBuild(input: { bucketId?: string | null; bucketCode?: string | null }, op: BuildOperator): Promise<BuildOutcome> {
	const bucket = input.bucketId
		? await SpuBucket.findOne({ _id: input.bucketId, active: true }).lean() as any
		: await findBucket(normalizeBucketCode(input.bucketCode ?? '')) as any;
	if (!bucket) {
		throw new BuildError(input.bucketCode?.trim()
			? `${input.bucketCode.trim()} isn't a registered bucket. Scan it to add it as a new bucket.`
			: 'That bucket is no longer registered. Reload the page.');
	}
	const bucketCode = bucket.qrCode;
	const label = `Bucket ${bucket.number}`;
	const wi = await requireWi();

	const holder = await SpuBuild.findOne({ bucketCode, status: 'in_progress' }).select('buildNumber').lean() as any;
	if (holder) throw new BuildError(`${label} already holds SPU ${holder.buildNumber}. Finish that build or use another bucket.`);

	// buildNumber is unique: if two stations start at the same moment, the loser retries with the next number.
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const last = await SpuBuild.findOne({}).sort({ buildNumber: -1 }).select('buildNumber').lean() as any;
		const buildNumber = (last?.buildNumber ?? 0) + 1;
		const now = new Date();
		try {
			const doc = await SpuBuild.create({
				_id: generateId(),
				buildNumber,
				bucketCode,
				bucketId: String(bucket._id),
				bucketNumber: bucket.number,
				status: 'in_progress',
				wiId: String(wi._id),
				wiDocumentNumber: wi.documentNumber,
				wiVersionAtStart: wi.currentVersion,
				startedBy: operatorDoc(op),
				startedAt: now,
				lastActivityAt: now,
				lastActivityBy: op.name,
				completedSteps: [],
				scans: []
			});
			await audit('INSERT', { _id: doc._id, buildNumber, bucketCode, bucketNumber: bucket.number }, op, { operation: 'spu_build_start', wiVersion: wi.currentVersion });
			return { kind: 'ok', message: `SPU ${buildNumber} started in ${label} by ${op.name}.`, buildId: String(doc._id) };
		} catch (e: any) {
			if (e?.code !== 11000) throw e;
			const clash = await SpuBuild.findOne({ bucketCode, status: 'in_progress' }).select('buildNumber').lean() as any;
			if (clash) throw new BuildError(`${label} was just started as SPU ${clash.buildNumber} at another station.`);
		}
	}
	throw new BuildError('Could not assign an SPU number. Try again.');
}

// ── scans ──────────────────────────────────────────────────────────────────

async function findLot(code: string): Promise<any | null> {
	const variants = [...new Set([code, code.toUpperCase(), code.toLowerCase()])];
	return ReceivingLot.findOne({
		$or: [{ lotId: { $in: variants } }, { bagBarcode: { $in: variants } }, { lotNumber: { $in: variants } }]
	}).select('_id lotId lotNumber bagBarcode status part').lean();
}

async function findPartByLabel(code: string): Promise<any | null> {
	return PartDefinition.findOne({
		$or: [{ partNumber: code.toUpperCase() }, { barcode: { $in: [code, code.toLowerCase()] } }, { altBarcodes: code.toLowerCase() }]
	}).select('partNumber name').lean();
}

/** A code that is some other kind of label, so it must never become a bucket. Null = none of these. */
async function whatElseIsIt(code: string): Promise<string | null> {
	if (/^BDG-/i.test(code)) return 'an operator badge';
	const variants = [...new Set([code, code.toUpperCase(), code.toLowerCase()])];
	const [lot, part, cart, tub] = await Promise.all([
		findLot(code),
		findPartByLabel(code),
		CartridgeRecord.exists({ _id: { $in: variants } }),
		resolveBucketId(code)
	]);
	if (lot) return `the lot label for ${lot.part?.partNumber ?? 'a part'}`;
	if (part) return String(part.partNumber).toUpperCase() === code.toUpperCase() ? 'a part number' : `the part label for ${part.partNumber}`;
	if (cart) return 'a cartridge label';
	if (tub) return `cartridge-line tub ${tub}`;
	return null;
}

export type ScanOutcome = BuildOutcome & {
	/** 'open': show this build. 'register-bucket': offer to add bucketCode as Bucket bucketNumber. */
	action?: 'open' | 'register-bucket';
	bucketCode?: string;
	bucketNumber?: number;
};

/**
 * Everything typed or scanned into the scan bar comes here, in this order:
 * a bucket holding an SPU in progress (opens it) → a registered bucket with no
 * SPU in it (starts the next SPU and opens it) → a bag's lot label (deduct
 * against the open build) → a badge, part, cartridge or tub label (explained,
 * nothing recorded) → any other QR code is offered as a new bucket.
 */
export async function handleScan(
	input: { code: string; buildId?: string | null; sectionNumber?: number | null },
	op: BuildOperator
): Promise<ScanOutcome> {
	const raw = input.code.trim();
	if (!raw) throw new BuildError('Scan the bucket barcode.');

	const code = normalizeBucketCode(raw);
	if (code) {
		const holderOf = () => SpuBuild.findOne({ bucketCode: code, status: 'in_progress' }).select('_id buildNumber bucketCode bucketNumber').lean() as any;
		const holder = await holderOf();
		if (holder) return { kind: 'ok', action: 'open', buildId: String(holder._id), bucketCode: holder.bucketCode, message: `${bucketLabel(holder)} scanned. Now working on SPU ${holder.buildNumber}.` };
		const bucket = await findBucket(code);
		if (bucket) {
			try {
				return { ...(await startBuild({ bucketId: String(bucket._id) }, op)), action: 'open', bucketCode: code };
			} catch (e) {
				// another station started this bucket in the same instant: open theirs
				const now = await holderOf();
				if (e instanceof BuildError && now) return { kind: 'ok', action: 'open', buildId: String(now._id), bucketCode: code, message: `${bucketLabel(now)} scanned. Now working on SPU ${now.buildNumber}.` };
				throw e;
			}
		}
	}

	const lot = await findLot(raw);
	if (lot) {
		if (!input.buildId || input.sectionNumber == null) return warn(`Scan the bucket barcode first, so ${lot.part?.partNumber ?? lotName(lot)} is deducted against the right SPU. Nothing deducted.`);
		return recordLotScan({ buildId: input.buildId, sectionNumber: input.sectionNumber, code: raw }, op, lot);
	}

	const other = await whatElseIsIt(raw);
	if (other) {
		if (other === 'an operator badge') return warn(`${raw} is an operator badge. Use Change operator to switch who is building.`);
		const hint = input.buildId ? 'Scan the lot label on the bag the part came from.' : 'Scan the bucket barcode.';
		return warn(`${raw} is ${other}, not a bucket or lot label. ${hint} Nothing recorded.`);
	}

	if (!code) return warn(`${raw} doesn't look like a bucket barcode. Nothing recorded.`);
	return {
		kind: input.buildId ? 'warn' : 'ok',
		action: 'register-bucket',
		bucketCode: code,
		bucketNumber: await nextBucketNumber(),
		message: input.buildId ? `${raw} is not a bucket or a lot label in BIMS yet.` : ''
	};
}

/** Scan of the lot label on a parts bag, against the build and section on screen. */
export async function recordLotScan(
	input: { buildId: string; sectionNumber: number; code: string },
	op: BuildOperator,
	resolvedLot?: any
): Promise<BuildOutcome> {
	const code = input.code.trim();
	if (!code) throw new BuildError('Scan the lot label on the bag.');
	const build = await loadOpenBuild(input.buildId);
	const wi = await requireWi();
	const section = sectionOrThrow(wi, input.sectionNumber);
	const label = tabLabel(section);

	// Parts are scanned by the lot label on their bag; a bare part label is not enough.
	const lot = resolvedLot ?? await findLot(code);
	if (!lot) {
		const part = await findPartByLabel(code) as any;
		if (part) {
			const what = String(part.partNumber).toUpperCase() === code.toUpperCase() ? `${part.partNumber} is a part number` : `${code} is the part label for ${part.partNumber}`;
			return warn(`${what}, not a lot label. Scan the lot label on the bag the part came from. Nothing deducted.`);
		}
		return warn(`${code} is not a lot label in BIMS. Scan the lot label on the bag. Nothing deducted.`);
	}
	if (lot.status === 'rejected' || lot.status === 'returned') {
		return warn(`Lot ${lotName(lot)} was ${lot.status} at receiving. Set it aside and use another bag. Nothing deducted.`);
	}

	const part = { partDefinitionId: lot.part?._id ?? null, partNumber: lot.part?.partNumber ?? null };
	const pn = part.partNumber || lot.part?.name || `Lot ${lotName(lot)}`;
	const hit = findStepForPart(section, build, part);
	const needs = (st: WiStep) => partsLeft(st, build).map(partLabel).join(', ');
	if (hit.kind === 'section-scanned') return warn(`Every part for ${label} is already scanned on SPU ${build.buildNumber}. Confirm ${label} complete at the end of its steps. Nothing deducted.`);
	if (hit.kind === 'out-of-order') return warn(`${pn} is for step ${hit.step.stepNumber}. Finish step ${hit.current.stepNumber} first: scan ${needs(hit.current)}. Nothing deducted.`);
	if (hit.kind === 'already-scanned') {
		const current = currentStep(section, build);
		return warn(`${pn} is already scanned on SPU ${build.buildNumber}.${current ? ` Step ${current.stepNumber} needs ${needs(current)}.` : ''} Nothing deducted.`);
	}
	if (hit.kind === 'not-in-section') {
		const elsewhere = sectionsUsingPart(wi, part).map((s) => tabLabel(s));
		return warn(elsewhere.length
			? `${pn} is not used in ${label}. It is used in ${elsewhere.join(', ')}. Nothing deducted.`
			: `${pn} is not a part on this work instruction. Nothing deducted.`);
	}
	return applyPart({ build, wi, section, step: hit.step, material: hit.material, lot, scannedCode: code }, op);
}

/** A part that isn't in the catalog has no lot label to scan: record its use without a deduction. */
export async function recordUncataloguedPart(input: { buildId: string; sectionNumber: number; stepId: string; materialId: string }, op: BuildOperator): Promise<BuildOutcome> {
	const build = await loadOpenBuild(input.buildId);
	const wi = await requireWi();
	const section = sectionOrThrow(wi, input.sectionNumber);
	const step = findStep(section, { stepId: input.stepId });
	if (!step) throw new BuildError('That step is no longer in this section. Reload the page.');
	const material = partsOf(step).find((m) => m._id === input.materialId);
	if (!material) throw new BuildError('That part is no longer on this step. Reload the page.');
	if (material.partDefinitionId) throw new BuildError(`${partLabel(material)} is in the catalog. Scan the lot label on its bag.`);
	const current = currentStep(section, build);
	if (current && current._id !== step._id) throw new BuildError(`Finish step ${current.stepNumber} first, then record ${partLabel(material)} for step ${step.stepNumber}.`);
	return applyPart({ build, wi, section, step, material, lot: null, scannedCode: null }, op);
}

async function applyPart(
	args: { build: any; wi: any; section: any; step: WiStep; material: WiMaterial; lot: any | null; scannedCode: string | null },
	op: BuildOperator
): Promise<BuildOutcome> {
	const { build, wi, section, step, material, lot } = args;
	const now = new Date();
	const scanId = generateId();
	const quantity = Number(material.quantity) > 0 ? Number(material.quantity) : 1;
	const unit = material.unit || 'ea';
	const lotLabel = lot ? lotName(lot) : null;
	const willDeduct = Boolean(lot) && deducts(material);
	const pn = partLabel(material);

	// Claim the slot before touching stock, so a scanner that fires twice can never deduct twice.
	const claim = await SpuBuild.updateOne(
		{
			_id: build._id,
			status: 'in_progress',
			// an undone scan no longer holds its slot, so the part can be scanned again
			scans: { $not: { $elemMatch: { stepId: step._id, materialId: material._id, status: { $in: [...SLOT_HOLDING_STATUSES] } } } }
		},
		{
			$push: {
				scans: {
					_id: scanId,
					status: 'pending',
					stepId: step._id,
					sectionNumber: section.number,
					stepNumber: step.stepNumber,
					materialId: material._id,
					partDefinitionId: material.partDefinitionId ?? null,
					partNumber: material.partNumber ?? null,
					name: material.name,
					quantity,
					unit,
					deducted: false,
					scannedCode: args.scannedCode,
					receivingLotId: lot ? String(lot._id) : null,
					lotLabel,
					operator: operatorDoc(op),
					scannedAt: now
				}
			},
			$set: { lastActivityAt: now, lastActivityBy: op.name }
		}
	);
	if (!claim.modifiedCount) return warn(`${pn} was already recorded for step ${step.stepNumber} on SPU ${build.buildNumber}. Nothing deducted.`);

	let pull: { inventoryTransactionId: string; materialPullId: string; previousQuantity: number | null; newQuantity: number | null } | null = null;
	if (willDeduct) {
		try {
			const r = await pullMaterialsForStep({
				sectionNumber: section.number,
				stepId: step._id,
				items: [{ materialId: material._id, quantity }],
				unitsBuilt: 1,
				deviceSerial: null,
				notes: `SPU build ${build.buildNumber} · ${bucketLabel(build)} · lot ${lotLabel} · operator ${op.name}`,
				lotId: String(lot._id),
				spuBuildId: String(build._id)
			}, op.user);
			pull = r.results[0];
		} catch (e) {
			await SpuBuild.updateOne({ _id: build._id }, { $pull: { scans: { _id: scanId } } });
			throw e;
		}
	}

	await SpuBuild.updateOne(
		{ _id: build._id, 'scans._id': scanId },
		{
			$set: {
				'scans.$.status': 'recorded',
				'scans.$.deducted': willDeduct,
				'scans.$.inventoryTransactionId': pull?.inventoryTransactionId ?? null,
				'scans.$.materialPullId': pull?.materialPullId ?? null,
				'scans.$.previousQuantity': pull?.previousQuantity ?? null,
				'scans.$.newQuantity': pull?.newQuantity ?? null
			}
		}
	);
	if (!willDeduct) {
		// Deducted scans are audited by pullMaterialsForStep; this covers the rest.
		await audit('UPDATE', build, op, {
			operation: 'spu_build_part_recorded',
			step: `${tabLabel(section)} step ${step.stepNumber}`,
			partNumber: material.partNumber ?? null,
			name: material.name,
			lot: lotLabel,
			reason: lot ? 'material is set not to deduct from inventory' : 'part is not in the inventory catalog'
		});
	}

	// Say where to go next: the rest of this step, the next step, or the section's confirm button.
	const fresh = await SpuBuild.findById(build._id).select('scans').lean() as any;
	const next = fresh ? currentStep(section, fresh) : null;
	const label = tabLabel(section);
	const tail = !next
		? ` Every part for ${label} is in. Confirm ${label} complete at the end of its steps.`
		: next._id !== step._id ? ` Step ${step.stepNumber} is scanned. Next: step ${next.stepNumber}.` : '';

	if (!willDeduct) {
		const why = lot ? 'it is set not to deduct from inventory' : 'it is not linked to the inventory catalog';
		return { kind: 'warn', message: `${pn} recorded for step ${step.stepNumber} on SPU ${build.buildNumber}, but ${why}, so nothing was deducted.${tail}` };
	}
	const after = pull?.newQuantity;
	if (after != null && after < 0) {
		return { kind: 'warn', message: `${pn}: deducted ${quantity} ${unit} from ${lotLabel}. Stock is now ${after}, so inventory is short.${tail}` };
	}
	return { kind: 'ok', message: `${pn}: deducted ${quantity} ${unit} from ${lotLabel} (${pull?.previousQuantity} → ${after}).${tail}` };
}

// ── sections ───────────────────────────────────────────────────────────────

/**
 * The operator confirms a whole section done (Setup, Sub-Assembly 1, …) with one
 * button at the end of its steps, once every part in it is scanned. That marks
 * all of its steps complete; when every section is confirmed, the SPU is complete.
 */
export async function completeSection(input: { buildId: string; sectionNumber: number }, op: BuildOperator): Promise<BuildOutcome> {
	const build = await loadOpenBuild(input.buildId);
	const wi = await requireWi();
	const section = sectionOrThrow(wi, input.sectionNumber);
	const label = tabLabel(section);
	if (!section.steps.length) throw new BuildError(`${label} has no steps to confirm.`);
	if (sectionConfirmed(section, build)) return warn(`${label} is already confirmed complete on SPU ${build.buildNumber}.`);

	// Every part must be recorded — a scan still in flight doesn't count yet.
	const recorded = scannedKeys(build, { recordedOnly: true });
	const unfinished = section.steps.find((st: WiStep) => partsOf(st).some((m) => !recorded.has(scanKey(st._id, m._id))));
	if (unfinished) {
		const left = partsOf(unfinished).filter((m) => !recorded.has(scanKey(unfinished._id, m._id))).map(partLabel).join(', ');
		throw new BuildError(`${label} isn't finished: step ${unfinished.stepNumber} still needs ${left}. Scan every part before confirming.`);
	}

	const now = new Date();
	const done = doneStepIds(build);
	const entries = section.steps
		.filter((st: WiStep) => !done.has(st._id))
		.map((st: WiStep) => ({ stepId: st._id, sectionNumber: section.number, stepNumber: st.stepNumber, how: 'section', operator: operatorDoc(op), completedAt: now }));
	const r = await SpuBuild.updateOne(
		// none of these steps already on the list, so a double tap can't push them twice
		{ _id: build._id, status: 'in_progress', 'completedSteps.stepId': { $nin: entries.map((e: any) => e.stepId) } },
		{ $push: { completedSteps: { $each: entries } }, $set: { lastActivityAt: now, lastActivityBy: op.name } }
	);
	if (!r.modifiedCount) return warn(`${label} was just confirmed on SPU ${build.buildNumber}.`);
	await audit('UPDATE', build, op, { operation: 'spu_build_section_done', section: label, steps: section.steps.length });
	const finished = await completeBuildIfDone(build, wi, op, now);
	return {
		kind: 'ok',
		message: finished ? `${label} confirmed complete. SPU ${build.buildNumber} is complete.` : `${label} confirmed complete on SPU ${build.buildNumber}.`
	};
}

async function completeBuildIfDone(build: any, wi: any, op: BuildOperator, now: Date): Promise<boolean> {
	const after = await SpuBuild.findById(build._id).select('completedSteps status').lean() as any;
	const { done, total } = buildProgress(wi, after);
	if (total === 0 || done < total) return false;
	const closed = await SpuBuild.updateOne({ _id: build._id, status: 'in_progress' }, { $set: { status: 'completed', completedAt: now } });
	if (closed.modifiedCount) await audit('UPDATE', build, op, { operation: 'spu_build_complete', steps: total });
	return closed.modifiedCount > 0;
}

// ── corrections ────────────────────────────────────────────────────────────
//
// Nothing is erased. An undone scan stays on the build marked 'undone' with its
// reason; its stock comes back through a NEW reversing transaction (the original
// InventoryTransaction and DeviceAssemblyMaterialPull are immutable), written the
// way bucket-service retracts: a negative 'consumption' row on the same lot with
// the retracted* fields set, so per-lot consumption sums net out. Every
// correction is also appended to build.corrections and the AuditLog.

const REASON_MAX = 200;

function cleanReason(raw: string | null | undefined): string {
	const reason = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, REASON_MAX);
	if (!reason) throw new BuildError('Say why, so the record shows what happened.');
	return reason;
}

function scanLabel(scan: any): string {
	return scan.partNumber || scan.name || 'Part';
}

async function stepLabel(sectionNumber: number | null, stepNumber: number | null): Promise<string> {
	const wi = await getDeviceAssemblyWI();
	const section = wi && sectionNumber != null ? findSection(wi, sectionNumber) : null;
	return `${section ? tabLabel(section) : `Section ${sectionNumber}`} step ${stepNumber}`;
}

/** Refuse to reopen a completed build whose bucket another build has since taken. */
async function assertBucketFree(build: any): Promise<void> {
	if (build.status !== 'completed') return;
	const holder = await SpuBuild.findOne({ bucketCode: build.bucketCode, status: 'in_progress', _id: { $ne: build._id } }).select('buildNumber').lean() as any;
	if (holder) throw new BuildError(`${bucketLabel(build)} now holds SPU ${holder.buildNumber}, so SPU ${build.buildNumber} can't be reopened. Nothing changed.`);
}

/** A completed build goes back to in progress once one of its steps is open again. */
async function reopenIfCompleted(build: any, op: BuildOperator, reason: string): Promise<boolean> {
	if (build.status !== 'completed') return false;
	try {
		const r = await SpuBuild.updateOne(
			{ _id: build._id, status: 'completed' },
			{
				$set: { status: 'in_progress', completedAt: null },
				$push: { corrections: { _id: generateId(), kind: 'reopen_build', summary: `SPU ${build.buildNumber} reopened`, reason, operator: operatorDoc(op), at: new Date() } }
			}
		);
		return r.modifiedCount > 0;
	} catch (e: any) {
		if (e?.code === 11000) return false; // bucket reused in the same instant; the build stays closed
		throw e;
	}
}

/** Put a deducted scan's quantity back on the shelf. Returns null when nothing had been deducted. */
async function returnToStock(build: any, scan: any, op: BuildOperator, reason: string) {
	const quantity = Number(scan.quantity) || 0;
	if (!scan.deducted || !scan.partDefinitionId || !(quantity > 0)) return null;
	const part = await PartDefinition.findOneAndUpdate(
		{ _id: scan.partDefinitionId },
		{ $inc: { inventoryCount: quantity } },
		{ returnDocument: 'after', lean: true }
	) as any;
	if (!part) throw new BuildError(`${scanLabel(scan)} is no longer in the parts catalog, so its stock can't be returned.`);
	const newQuantity = Number(part.inventoryCount ?? 0);
	const previousQuantity = newQuantity - quantity;
	const now = new Date();
	const note = `Undo of SPU build ${build.buildNumber} scan (${bucketLabel(build)}, ${scanLabel(scan)}, lot ${scan.lotLabel ?? '—'}): ${reason} · operator ${op.name}`;

	const transactionId = generateId();
	await InventoryTransaction.create({
		_id: transactionId,
		transactionType: 'consumption',
		partDefinitionId: scan.partDefinitionId,
		lotId: scan.receivingLotId ?? undefined,
		quantity: -quantity,
		previousQuantity,
		newQuantity,
		operatorId: op.user._id,
		operatorUsername: op.user.username,
		performedBy: op.user.username,
		performedAt: now,
		notes: note,
		reason: note,
		retractedBy: op.user.username,
		retractedAt: now,
		retractionReason: reason
	});

	const original = scan.materialPullId ? await DeviceAssemblyMaterialPull.findById(scan.materialPullId).lean() as any : null;
	const pullId = generateId();
	await DeviceAssemblyMaterialPull.create({
		_id: pullId,
		wiId: original?.wiId ?? build.wiId ?? 'unknown',
		wiVersion: original?.wiVersion ?? null,
		sectionNumber: scan.sectionNumber ?? original?.sectionNumber ?? 0,
		sectionTitle: original?.sectionTitle ?? '',
		stepId: scan.stepId,
		stepNumber: scan.stepNumber ?? original?.stepNumber ?? 0,
		materialId: scan.materialId,
		partDefinitionId: scan.partDefinitionId,
		partNumber: scan.partNumber ?? null,
		name: scan.name ?? '',
		quantity: -quantity,
		unit: scan.unit ?? 'ea',
		unitsBuilt: 1,
		deviceSerial: null,
		spuBuildId: String(build._id),
		lotId: scan.receivingLotId ?? null,
		reversesPullId: scan.materialPullId ?? null,
		inventoryTransactionId: transactionId,
		previousQuantity,
		newQuantity,
		performedBy: op.user,
		performedAt: now,
		notes: note
	});
	return { transactionId, pullId, previousQuantity, newQuantity, quantity };
}

/** Claim a recorded scan for undo (recorded → undoing), so two taps can't return the stock twice. */
async function claimForUndo(buildId: string, scanId: string): Promise<boolean> {
	const r = await SpuBuild.updateOne(
		{ _id: buildId, scans: { $elemMatch: { _id: scanId, status: 'recorded' } } },
		{ $set: { 'scans.$.status': 'undoing' } }
	);
	return r.modifiedCount > 0;
}

async function releaseUndoClaim(buildId: string, scanId: string) {
	await SpuBuild.updateOne({ _id: buildId, scans: { $elemMatch: { _id: scanId, status: 'undoing' } } }, { $set: { 'scans.$.status': 'recorded' } });
}

function undoneFields(op: BuildOperator, reason: string, ret: Awaited<ReturnType<typeof returnToStock>>, at: Date) {
	return {
		'scans.$.status': 'undone',
		'scans.$.undoneAt': at,
		'scans.$.undoneBy': operatorDoc(op),
		'scans.$.undoReason': reason,
		'scans.$.reversalTransactionId': ret?.transactionId ?? null,
		'scans.$.reversalPullId': ret?.pullId ?? null,
		'scans.$.returnedQuantity': ret?.newQuantity ?? null
	};
}

/**
 * Undo one scan: its quantity goes back in stock, its step is open again, and
 * the part can be scanned again. Works on a completed build (which reopens) and
 * on a cancelled one (stock only — for parts left deducted when it was cancelled).
 */
export async function undoScan(input: { buildId: string; scanId: string; reason: string }, op: BuildOperator): Promise<BuildOutcome> {
	const reason = cleanReason(input.reason);
	const build = await SpuBuild.findById(input.buildId).lean() as any;
	if (!build) throw new BuildError('That build no longer exists. Reload the page.');
	const scan = (build.scans ?? []).find((s: any) => s._id === input.scanId);
	if (!scan) throw new BuildError('That scan is no longer on this build. Reload the page.');
	const pn = scanLabel(scan);
	if (scan.status === 'undone' || scan.status === 'undoing') return warn(`${pn} on SPU ${build.buildNumber} was already undone. Nothing changed.`);
	if (scan.status !== 'recorded') throw new BuildError(`${pn} is still being recorded. Wait a moment, then try again.`);
	await assertBucketFree(build);

	if (!(await claimForUndo(build._id, scan._id))) return warn(`${pn} on SPU ${build.buildNumber} was already undone. Nothing changed.`);
	let ret: Awaited<ReturnType<typeof returnToStock>> = null;
	try {
		ret = await returnToStock(build, scan, op, reason);
	} catch (e) {
		await releaseUndoClaim(build._id, scan._id);
		throw e;
	}

	const now = new Date();
	const where = await stepLabel(scan.sectionNumber, scan.stepNumber);
	// A confirmed section is no longer finished once one of its parts is out: it reopens.
	const wi = await getDeviceAssemblyWI();
	const home = wi?.sections.find((s: any) => s.steps.some((st: any) => st._id === scan.stepId)) ?? null;
	const sectionStepIds: string[] = home ? home.steps.map((st: any) => st._id) : [scan.stepId];
	const sectionName = home ? tabLabel(home) : 'Its section';
	const sectionWasDone = build.status !== 'cancelled' && (build.completedSteps ?? []).some((c: any) => sectionStepIds.includes(c.stepId));
	const summary = `Undid ${pn} for ${where}${ret ? `: ${ret.quantity} ${scan.unit ?? 'ea'} back in stock (${ret.previousQuantity} → ${ret.newQuantity})` : ' (nothing had been deducted)'}`;
	await SpuBuild.updateOne(
		{ _id: build._id, 'scans._id': scan._id },
		{
			$set: { ...undoneFields(op, reason, ret, now), lastActivityAt: now, lastActivityBy: op.name },
			...(build.status !== 'cancelled' ? { $pull: { completedSteps: { stepId: { $in: sectionStepIds } } } } : {}),
			$push: { corrections: { _id: generateId(), kind: 'undo_scan', scanId: scan._id, stepId: scan.stepId, sectionNumber: scan.sectionNumber, stepNumber: scan.stepNumber, summary, reason, operator: operatorDoc(op), at: now } }
		}
	);
	const reopened = sectionWasDone ? await reopenIfCompleted(build, op, reason) : false;
	await audit('UPDATE', build, op, {
		operation: 'spu_build_undo_scan',
		step: where,
		partNumber: scan.partNumber ?? null,
		lot: scan.lotLabel ?? null,
		returned: ret ? { quantity: ret.quantity, from: ret.previousQuantity, to: ret.newQuantity, inventoryTransactionId: ret.transactionId } : null,
		reason
	});

	const again = scan.receivingLotId ? 'Scan it again' : 'Record it again';
	const tail = `${build.status !== 'cancelled' ? ` ${again} for step ${scan.stepNumber}.` : ''}${sectionWasDone ? ` ${sectionName} is open again; confirm it again once its parts are in.` : ''}${reopened ? ` SPU ${build.buildNumber} is back in progress.` : ''}`;
	return ret
		? { kind: 'ok', message: `Undid ${pn} on SPU ${build.buildNumber}: ${ret.quantity} ${scan.unit ?? 'ea'} back in stock (${ret.previousQuantity} → ${ret.newQuantity}).${tail}` }
		: { kind: 'ok', message: `Undid ${pn} on SPU ${build.buildNumber}. Nothing had been deducted, so stock is unchanged.${tail}` };
}

/** Take back a section confirmation (confirmed by mistake, or work has to be redone). Its scans stay. */
export async function reopenSection(input: { buildId: string; sectionNumber: number; reason: string }, op: BuildOperator): Promise<BuildOutcome> {
	const reason = cleanReason(input.reason);
	const build = await SpuBuild.findById(input.buildId).lean() as any;
	if (!build) throw new BuildError('That build no longer exists. Reload the page.');
	if (build.status === 'cancelled') throw new BuildError(`SPU ${build.buildNumber} was cancelled. Nothing to reopen.`);
	const wi = await requireWi();
	const section = sectionOrThrow(wi, input.sectionNumber);
	const label = tabLabel(section);
	const ids: string[] = section.steps.map((st: WiStep) => st._id);
	if (!(build.completedSteps ?? []).some((c: any) => ids.includes(c.stepId))) return warn(`${label} is not confirmed on SPU ${build.buildNumber}. Nothing changed.`);
	await assertBucketFree(build);

	const now = new Date();
	const r = await SpuBuild.updateOne(
		{ _id: build._id, status: { $ne: 'cancelled' }, 'completedSteps.stepId': { $in: ids } },
		{
			$pull: { completedSteps: { stepId: { $in: ids } } },
			$set: { lastActivityAt: now, lastActivityBy: op.name },
			$push: { corrections: { _id: generateId(), kind: 'reopen_section', sectionNumber: section.number, summary: `Reopened ${label}`, reason, operator: operatorDoc(op), at: now } }
		}
	);
	if (!r.modifiedCount) return warn(`${label} is not confirmed on SPU ${build.buildNumber}. Nothing changed.`);
	const reopened = await reopenIfCompleted(build, op, reason);
	await audit('UPDATE', build, op, { operation: 'spu_build_reopen_section', section: label, reason });
	return { kind: 'ok', message: `${label} is open again on SPU ${build.buildNumber}.${reopened ? ` SPU ${build.buildNumber} is back in progress.` : ''}` };
}

/**
 * Cancel a build that should not exist (wrong bucket, started by mistake,
 * abandoned). Its bucket is free straight away. `returnParts` puts every
 * deducted part back in stock; leave it off when the parts were used or scrapped.
 */
export async function cancelBuild(input: { buildId: string; reason: string; returnParts: boolean }, op: BuildOperator): Promise<BuildOutcome> {
	const reason = cleanReason(input.reason);
	const build = await SpuBuild.findById(input.buildId).lean() as any;
	if (!build) throw new BuildError('That build no longer exists. Reload the page.');
	if (build.status === 'cancelled') return warn(`SPU ${build.buildNumber} is already cancelled.`);
	if (build.status === 'completed') throw new BuildError(`SPU ${build.buildNumber} is complete, so it can't be cancelled here. Undo a scan first if it is not really finished.`);
	if ((build.scans ?? []).some((s: any) => s.status === 'pending' || s.status === 'undoing')) {
		throw new BuildError(`A scan on SPU ${build.buildNumber} is still being recorded. Wait a moment, then try again.`);
	}

	const deducted = (build.scans ?? []).filter((s: any) => s.status === 'recorded' && s.deducted);
	const returnParts = Boolean(input.returnParts) && deducted.length > 0;
	const now = new Date();
	// Close it first: that frees the bucket and stops new scans landing on it.
	const closed = await SpuBuild.updateOne(
		{ _id: build._id, status: 'in_progress' },
		{
			$set: {
				status: 'cancelled',
				cancelledAt: now,
				cancelledBy: operatorDoc(op),
				cancelReason: reason,
				partsReturnedOnCancel: deducted.length ? returnParts : null,
				lastActivityAt: now,
				lastActivityBy: op.name
			},
			$push: {
				corrections: {
					_id: generateId(),
					kind: 'cancel_build',
					summary: `Cancelled SPU ${build.buildNumber} in ${bucketLabel(build)}${deducted.length ? (returnParts ? `, returning ${deducted.length} scanned part${deducted.length === 1 ? '' : 's'} to stock` : `, leaving ${deducted.length} scanned part${deducted.length === 1 ? '' : 's'} deducted`) : ''}`,
					reason,
					operator: operatorDoc(op),
					at: now
				}
			}
		}
	);
	if (!closed.modifiedCount) return warn(`SPU ${build.buildNumber} is no longer in progress. Reload the page.`);

	let returned = 0;
	const failed: string[] = [];
	if (returnParts) {
		const why = `Build cancelled: ${reason}`;
		for (const scan of deducted) {
			if (!(await claimForUndo(build._id, scan._id))) continue;
			try {
				const ret = await returnToStock(build, scan, op, why);
				await SpuBuild.updateOne({ _id: build._id, 'scans._id': scan._id }, { $set: undoneFields(op, why, ret, new Date()) });
				returned += 1;
			} catch (e) {
				console.error('[spu-build] cancel: could not return', scan._id, e);
				await releaseUndoClaim(build._id, scan._id);
				failed.push(scanLabel(scan));
			}
		}
	}
	await audit('UPDATE', build, op, { operation: 'spu_build_cancel', reason, scannedParts: deducted.length, partsReturned: returned, returnFailed: failed });

	let message = `SPU ${build.buildNumber} cancelled. ${bucketLabel(build)} is free for a new build.`;
	if (returnParts) message += ` ${returned} scanned part${returned === 1 ? '' : 's'} back in stock.`;
	else if (deducted.length) message += ` ${deducted.length} scanned part${deducted.length === 1 ? '' : 's'} left deducted.`;
	if (failed.length) return { kind: 'warn', message: `${message} Could not return ${failed.join(', ')}; open the build and undo ${failed.length === 1 ? 'it' : 'them'}.` };
	return { kind: 'ok', message };
}
