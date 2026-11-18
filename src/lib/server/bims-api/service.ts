/**
 * BIMS API v1 — the three cartridge operations against the database.
 * Contract: docs/BIMS-API-V1.md.
 *
 * The only imports from the rest of the server are the database connection
 * and models, so this folder can be lifted out later.
 *
 * Reads select named fields only. Run data (`rawData`, `reading`) is read as a
 * presence flag, never its contents; customer, shipping, sample and experiment
 * fields are never returned (`experiment` is read to refuse research
 * cartridges and goes no further).
 *
 * Writes: `linkCartridge` and `unlinkCartridge` touch `status`,
 * `statusUpdatedOn`, `priorStatus` and `checkpoints.linked` on one
 * `cartridge_records` document, and add one `audit_log` row. Nothing else.
 */
import { AuditLog, CartridgeRecord, ShippingLot, Spu } from '$lib/server/db';
import { analyteForAssay } from './analytes';
import {
	LINKED,
	checkSummary,
	eligibility,
	evaluateLink,
	evaluateUnlink,
	expiryOf,
	linkedBy,
	type AppName,
	type CheckState,
	type Refusal,
	type RuleRecord
} from './rules';
import { curveOf, iso, reduceResult, runState, type ReducedResult, type RunState, type StoredAnalysis } from './result';

type Lot = {
	fillLotId: string | null;
	fillLotNumber: string | null;
	reagentLotId: string | null;
	reagentLotNumber: string | null;
};

type EligibilityRecord = RuleRecord & {
	_id: string;
	assayName?: string | null;
	reagentFilling?: (RuleRecord['reagentFilling'] & Partial<Record<keyof Lot, string | null>>) | null;
};

/** `true` when the field exists, removed when it does not: the optics never leave the database. */
const present = (field: string) => ({ $cond: [{ $eq: [{ $type: `$${field}` }, 'missing'] }, '$$REMOVE', true] });

const ELIGIBILITY_PROJECTION = {
	status: 1,
	priorStatus: 1,
	assayId: 1,
	assayName: 1,
	expirationDate: 1,
	'reagentFilling.expirationDate': 1,
	'reagentFilling.fillLotId': 1,
	'reagentFilling.fillLotNumber': 1,
	'reagentFilling.reagentLotId': 1,
	'reagentFilling.reagentLotNumber': 1,
	used: 1,
	voidedAt: 1,
	usedForTestFill: 1,
	experiment: 1,
	'checkpoints.linked.who': 1,
	rawData: present('rawData'),
	reading: present('reading')
};

async function readForEligibility(id: string): Promise<EligibilityRecord | null> {
	const [doc] = await CartridgeRecord.aggregate([{ $match: { _id: id } }, { $project: ELIGIBILITY_PROJECTION }]);
	return (doc as EligibilityRecord | undefined) ?? null;
}

/** A cartridge pulled for QA/QC release testing is not a test cartridge (same rule as the claim API). */
async function isQcCartridge(id: string): Promise<boolean> {
	return Boolean(await ShippingLot.exists({ 'qaqcReleases.qaqcCartridgeIds': id }));
}

const lotOf = (r: EligibilityRecord | { reagentFilling?: Partial<Record<keyof Lot, string | null>> | null }): Lot => ({
	fillLotId: r.reagentFilling?.fillLotId ?? null,
	fillLotNumber: r.reagentFilling?.fillLotNumber ?? null,
	reagentLotId: r.reagentFilling?.reagentLotId ?? null,
	reagentLotNumber: r.reagentFilling?.reagentLotNumber ?? null
});

// ---------------------------------------------------------------------------
// (a) Check

export type CheckResponse =
	| { cartridgeId: string; usable: false; reason: 'not_found' }
	| {
			cartridgeId: string;
			usable: boolean;
			reason: Refusal | null;
			state: CheckState;
			assay: { id: string | null; name: string | null };
			analyte: string | null;
			expiresOn: string | null;
			lot: Lot;
	  };

export async function checkCartridge(id: string, holderRef: string | null, now = new Date()): Promise<CheckResponse> {
	const [record, qc] = await Promise.all([readForEligibility(id), isQcCartridge(id)]);
	if (!record) return { cartridgeId: id, usable: false, reason: 'not_found' };
	const summary = checkSummary(eligibility(record, { holderRef, isQcCartridge: qc, now }));
	return {
		cartridgeId: id,
		...summary,
		assay: { id: record.assayId ?? null, name: record.assayName ?? null },
		analyte: analyteForAssay(record.assayName)?.id ?? null,
		expiresOn: expiryOf(record)?.toISOString() ?? null,
		lot: lotOf(record)
	};
}

// ---------------------------------------------------------------------------
// (b) Link and unlink

export type LinkResponse =
	| { ok: true; status: 'already' }
	| { ok: true; status: 'linked'; linkedAt: string }
	| { ok: false; reason: Refusal };

/**
 * No run data on the record at the moment of the write, and not finalized
 * (the sacred-document rule, db/middleware/sacred.ts, applied in the filter).
 */
const WRITABLE = { rawData: { $exists: false }, reading: { $exists: false }, finalizedAt: null };

/**
 * The conditional writes go through the driver's collection, not the Mongoose
 * model: the filter names fields the schema does not declare (`rawData`,
 * `reading`), and the update must change the named fields and nothing else
 * (no `updatedAt` bump, no casting, no defaults).
 */
const records = () => CartridgeRecord.collection;

/**
 * Link the cartridge to a holder. The write is conditional on the status that
 * was read and on there being no run data, so a cartridge that starts running
 * (or is linked by someone else) in between is never rewound; a missed write
 * is read again and judged afresh, once.
 */
export async function linkCartridge(id: string, holderRef: string, app: AppName, now = new Date()): Promise<LinkResponse> {
	const qc = await isQcCartridge(id);
	for (let attempt = 0; attempt < 2; attempt++) {
		const record = await readForEligibility(id);
		const decision = evaluateLink(record, { holderRef, app, isQcCartridge: qc, now });
		if (decision.action === 'refuse') return { ok: false, reason: decision.reason };
		if (decision.action === 'already') return { ok: true, status: 'already' };

		const res = await records().updateOne(
			{ _id: id, status: decision.fromStatus === null ? { $exists: false } : decision.fromStatus, ...WRITABLE } as any,
			{ $set: decision.set }
		);
		if (res.matchedCount === 1) {
			await AuditLog.create({
				tableName: 'cartridge_records',
				recordId: id,
				action: 'LINK',
				changedBy: `api:${app}`,
				changedAt: now,
				oldData: { status: decision.fromStatus },
				newData: { status: LINKED, priorStatus: decision.set.priorStatus, holderRef },
				changedFields: ['status', 'statusUpdatedOn', 'priorStatus', 'checkpoints.linked']
			});
			return { ok: true, status: 'linked', linkedAt: decision.linkedAt };
		}
	}
	// Changed twice under us: say it is busy rather than guess.
	return { ok: false, reason: 'in_use' };
}

export type UnlinkResponse =
	| { ok: true; status: 'unlinked'; restoredStatus: string | null }
	| { ok: true; status: 'not_linked' }
	| { ok: false; reason: 'not_found' | 'has_results' | 'linked_by_other' };

/**
 * Undo a link: only by the holder that made it, only while the record is
 * still `linked` with no run data. Restores `priorStatus`; never deletes.
 */
export async function unlinkCartridge(id: string, holderRef: string, app: AppName, now = new Date()): Promise<UnlinkResponse> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const decision = evaluateUnlink(await readForEligibility(id), holderRef);
		if (decision.action === 'refuse') return { ok: false, reason: decision.reason };
		if (decision.action === 'not_linked') return { ok: true, status: 'not_linked' };

		const when = now.toISOString();
		const restore = decision.restoredStatus;
		const res = await records().updateOne(
			{ _id: id, status: LINKED, 'checkpoints.linked.who': decision.who, ...WRITABLE } as any,
			{
				$set: restore === null ? { statusUpdatedOn: when } : { status: restore, statusUpdatedOn: when },
				$unset: { priorStatus: '', 'checkpoints.linked': '', ...(restore === null ? { status: '' } : {}) }
			}
		);
		if (res.matchedCount === 1) {
			await AuditLog.create({
				tableName: 'cartridge_records',
				recordId: id,
				action: 'UNLINK',
				changedBy: `api:${app}`,
				changedAt: now,
				oldData: { status: LINKED, priorStatus: restore },
				newData: { status: restore, holderRef },
				changedFields: ['status', 'statusUpdatedOn', 'priorStatus', 'checkpoints.linked']
			});
			return { ok: true, status: 'unlinked', restoredStatus: restore };
		}
	}
	// It left `linked` twice while we looked: a reader has it.
	return { ok: false, reason: 'has_results' };
}

// ---------------------------------------------------------------------------
// (c) Result

const WELL_FIELDS = ['qc.pass', 'qc.flags.key', 'quant.value', 'quant.unit', 'quant.status', 'quant.curveId', 'quant.curveVersion', 'quant.curveSource'];

/** Named fields only: no raw optics, metrics, samples, customer or experiment. */
const RESULT_PROJECTION: Record<string, 1> = [
	'status',
	'statusUpdatedOn',
	'assayId',
	'assayName',
	'checkpoints.linked.who',
	'checkpoints.underway.when',
	'checkpoints.completed.when',
	'analysis.schemaVersion',
	'analysis.engineVersion',
	'analysis.profileId',
	'analysis.profileName',
	'analysis.profileVersion',
	'analysis.computedAt',
	'analysis.quantifiedAt',
	...['A', 'B', 'C'].flatMap((w) => WELL_FIELDS.map((f) => `analysis.wells.${w}.${f}`)),
	'reagentFilling.fillLotId',
	'reagentFilling.fillLotNumber',
	'reagentFilling.reagentLotId',
	'reagentFilling.reagentLotNumber',
	'device.id',
	'device.firmware_version',
	'testExecution.spu.udi',
	'testExecution.spu.firmwareVersion'
].reduce<Record<string, 1>>((p, f) => ({ ...p, [f]: 1 }), {});

type ResultRecord = {
	_id: string;
	status?: string | null;
	statusUpdatedOn?: string | null;
	assayId?: string | null;
	assayName?: string | null;
	checkpoints?: {
		linked?: { who?: unknown } | null;
		underway?: { when?: unknown } | null;
		completed?: { when?: unknown } | null;
	} | null;
	analysis?: StoredAnalysis | null;
	reagentFilling?: Partial<Record<keyof Lot, string | null>> | null;
	device?: { id?: string | null; firmware_version?: string | number | null } | null;
	testExecution?: { spu?: { udi?: string | null; firmwareVersion?: string | null } | null } | null;
};

export type Provenance = Lot & {
	curve: { id: string | null; version: number | null; source: string | null };
	calculation: {
		engineVersion: string | null;
		profileId: string | null;
		profileName: string | null;
		profileVersion: number | null;
		computedAt: string | null;
		quantifiedAt: string | null;
	};
	reader: { serial: string | null; firmwareVersion: string | null; opticsCalibrationVersion: null };
};

export type ResultResponse =
	| {
			cartridgeId: string;
			state: Exclude<RunState, 'completed'>;
			startedAt: string | null;
			detail?: 'analysis_pending' | 'assay_unsupported' | 'not_linked';
	  }
	| {
			cartridgeId: string;
			state: 'completed';
			startedAt: string | null;
			completedAt: string | null;
			assay: { id: string | null; name: string | null };
			result: { analyte: string } & ReducedResult;
			provenance: Provenance;
	  };

/** The reader's serial: the SPU whose Particle device ran the cartridge. */
async function readerSerial(doc: ResultRecord): Promise<string | null> {
	if (doc.testExecution?.spu?.udi) return doc.testExecution.spu.udi;
	const deviceId = doc.device?.id;
	if (!deviceId) return null;
	const spu = (await Spu.findOne({ 'particleLink.particleDeviceId': deviceId }).select('udi').lean()) as { udi?: string } | null;
	return spu?.udi ?? null;
}

/**
 * The run's state and, once it is complete and analysed, its result. Null
 * when the record does not exist or was not linked by this holder: the two
 * are indistinguishable to the caller, so an app key cannot be used to read
 * results by guessing ids.
 */
export async function cartridgeResult(id: string, holderRef: string): Promise<ResultResponse | null> {
	const doc = (await records().findOne({ _id: id } as any, { projection: RESULT_PROJECTION })) as ResultRecord | null;
	if (!doc || !linkedBy(doc, holderRef)) return null;

	const analyte = analyteForAssay(doc.assayName);
	const { state, detail } = runState(doc.status, {
		analysed: doc.analysis?.schemaVersion === 2,
		knownAssay: analyte !== null
	});
	const startedAt = iso(doc.checkpoints?.underway?.when);
	if (state !== 'completed' || !analyte) {
		return { cartridgeId: id, state: state as Exclude<RunState, 'completed'>, startedAt, ...(detail ? { detail } : {}) };
	}

	const fw = doc.device?.firmware_version ?? doc.testExecution?.spu?.firmwareVersion ?? null;
	return {
		cartridgeId: id,
		state: 'completed',
		startedAt,
		completedAt: iso(doc.checkpoints?.completed?.when) ?? iso(doc.statusUpdatedOn),
		assay: { id: doc.assayId ?? null, name: doc.assayName ?? null },
		result: { analyte: analyte.id, ...reduceResult(doc.analysis, analyte.reportedWells) },
		provenance: {
			...lotOf(doc),
			curve: curveOf(doc.analysis, analyte.reportedWells),
			calculation: {
				engineVersion: doc.analysis?.engineVersion ?? null,
				profileId: doc.analysis?.profileId ?? null,
				profileName: doc.analysis?.profileName ?? null,
				profileVersion: doc.analysis?.profileVersion ?? null,
				computedAt: iso(doc.analysis?.computedAt),
				quantifiedAt: iso(doc.analysis?.quantifiedAt)
			},
			reader: {
				serial: await readerSerial(doc),
				firmwareVersion: fw === null || fw === '' ? null : String(fw),
				opticsCalibrationVersion: null
			}
		}
	};
}
