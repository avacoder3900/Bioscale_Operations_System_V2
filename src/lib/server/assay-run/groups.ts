/**
 * Assay-run groups: create, (re)evaluate, roll up. Members are
 * cartridge_records (sacred — read only); the group doc and the SPU rollup are
 * what gets written.
 */
import { connectDB, CartridgeRecord, CartridgeGroup, Spu, Integration, AuditLog, generateId } from '$lib/server/db';
import { appendSpuJournal } from '$lib/server/spu-journal';
import { autoEnterValidating } from '$lib/server/spu-auto-validate';
import { nextGroupColor } from '$lib/server/optical-constants';
import { evaluateGroup, mergeAssayRunCriteria, type AssayRunCriteria, type GroupEvaluation } from './evaluate';

export async function loadAssayRunCriteria(): Promise<AssayRunCriteria> {
	const doc = (await Integration.findOne({ type: 'assay_run_criteria' }).lean()) as any;
	return mergeAssayRunCriteria(doc?.criteria);
}

export interface Actor {
	_id: string;
	username?: string;
}

export async function createAssayRunGroup(
	input: { spuId: string; name: string; cartridgeIds: string[]; assayId?: string | null; lot?: string | null; intendedConcentration?: number | null; intendedConcentrationUnit?: string | null; description?: string | null },
	actor: Actor
): Promise<{ groupId: string } | { error: string }> {
	await connectDB();
	const spu = (await Spu.findById(input.spuId).select('udi validationResetAt').lean()) as any;
	if (!spu) return { error: 'Unit not found' };
	const ids = [...new Set(input.cartridgeIds.map((s) => s.trim()).filter(Boolean))];
	if (!ids.length) return { error: 'Scan at least one cartridge' };
	const used = (await CartridgeGroup.find({ purpose: 'assay_run', archivedAt: null }).select('color').lean()) as any[];
	const groupId = generateId();
	await CartridgeGroup.create({
		_id: groupId,
		name: input.name,
		description: input.description ?? null,
		color: nextGroupColor(used.map((g) => g.color)),
		createdBy: actor.username ?? actor._id,
		purpose: 'assay_run',
		cartridgeIds: ids,
		spuId: spu._id,
		spuUdi: spu.udi,
		cycleResetAt: spu.validationResetAt ?? null,
		assayId: input.assayId ?? null,
		lot: input.lot ?? null,
		intendedConcentration: input.intendedConcentration ?? null,
		intendedConcentrationUnit: input.intendedConcentrationUnit ?? null
	});
	await AuditLog.create({
		_id: generateId(),
		tableName: 'cartridge_groups',
		recordId: groupId,
		action: 'create',
		newData: { purpose: 'assay_run', spuUdi: spu.udi, name: input.name, cartridgeIds: ids },
		changedBy: actor.username ?? actor._id,
		changedAt: new Date()
	});
	await appendSpuJournal(spu._id, `Assay-run group "${input.name}" created with ${ids.length} cartridge${ids.length === 1 ? '' : 's'}`, actor, {
		source: 'validation',
		refKind: 'cartridge_group',
		refId: groupId,
		refLabel: 'Assay run'
	});
	await evaluateAssayRunGroup(groupId, actor);
	return { groupId };
}

/** Re-derive the group's evaluation from its members' records and write the SPU rollup. */
export async function evaluateAssayRunGroup(groupId: string, actor?: Actor): Promise<GroupEvaluation | null> {
	await connectDB();
	const group = (await CartridgeGroup.findById(groupId).lean()) as any;
	if (!group || group.purpose !== 'assay_run') return null;
	const criteria = await loadAssayRunCriteria();
	const ids: string[] = group.cartridgeIds ?? [];
	// .lean() is REQUIRED: rawData / device / analysis are undeclared on the schema.
	const records = ids.length ? ((await CartridgeRecord.find({ _id: { $in: ids } }).select('_id status assayId device rawData analysis checkpoints createdAt').lean()) as any[]) : [];
	const byId = new Map(records.map((r) => [r._id as string, r]));
	const ordered = ids.map((id) => byId.get(id) ?? { _id: id, status: null });
	const evaln = evaluateGroup(ordered, criteria);
	// Persist a compact copy (no readings) on the group.
	const compact = {
		...evaln,
		members: evaln.members.map((m) => ({ ...m, lanes: Object.fromEntries(Object.entries(m.lanes).map(([k, l]) => [k, { beadIndex: l.beadIndex, result: l.result, source: l.source, metrics: l.metrics }])) }))
	};
	const now = new Date();
	await CartridgeGroup.updateOne({ _id: groupId }, { $set: { evaluation: compact, evaluatedAt: now } });

	// Rollup: the group status (override wins), only onto an unfinalized unit.
	const status: 'pending' | 'passed' | 'failed' | 'overridden' = group.override?.status
		? (group.override.status as any)
		: evaln.passed == null
			? 'pending'
			: evaln.passed
				? 'passed'
				: 'failed';
	if (group.spuId) {
		const spu = (await Spu.findById(group.spuId).select('udi finalizedAt validation.assay_run').lean()) as any;
		if (spu && !spu.finalizedAt && status !== 'pending') {
			const prev = spu.validation?.assay_run?.status ?? 'pending';
			await Spu.updateOne(
				{ _id: group.spuId },
				{
					$set: {
						'validation.assay_run': {
							status,
							groupId,
							completedAt: now,
							rawData: { groupName: group.name, cartridgeIds: ids, lot: group.lot ?? null, assayId: group.assayId ?? null },
							results: { n: evaln.n, nValid: evaln.nValid, lanes: evaln.lanes, beadIndexMean: evaln.beadIndexMean, beadIndexCv: evaln.beadIndexCv, resultMean: evaln.resultMean, resultCv: evaln.resultCv, stage: evaln.stage },
							failureReasons: evaln.failureReasons,
							criteriaUsed: criteria
						}
					}
				}
			);
			await autoEnterValidating(group.spuId, 'assay_run', actor);
			if (prev !== status) {
				await AuditLog.create({
					_id: generateId(),
					tableName: 'spus',
					recordId: group.spuId,
					action: 'UPDATE',
					oldData: { 'validation.assay_run.status': prev },
					newData: { validationType: 'assay_run', status, groupId, failureReasons: evaln.failureReasons },
					changedBy: actor?.username ?? actor?._id ?? 'system:assay-run',
					changedAt: now,
					reason: `Assay-run group "${group.name}": ${status.toUpperCase()}${evaln.failureReasons.length ? ' — ' + evaln.failureReasons.slice(0, 3).join('; ') : ''}`
				});
				await appendSpuJournal(
					group.spuId,
					`Assay run ${status} — group "${group.name}", ${evaln.nValid}/${evaln.n} valid, bead index ${evaln.beadIndexMean ?? '—'} (CV ${evaln.beadIndexCv ?? '—'} %)`,
					actor ?? { _id: 'system:assay-run', username: 'assay-run' },
					{ source: 'validation', refKind: 'cartridge_group', refId: groupId, refLabel: 'Assay run' }
				);
			}
		}
	}
	return evaln;
}

/**
 * Records that landed after the group was made still attach by barcode because
 * the evaluation reads cartridge_records by the group's ids at every refresh —
 * nothing needs to be "attached". This re-evaluates every open group a record
 * belongs to; call it from a cron/refresh if auto-updating hub numbers is wanted.
 */
export async function refreshGroupsForCartridge(cartridgeId: string): Promise<number> {
	await connectDB();
	const groups = (await CartridgeGroup.find({ purpose: 'assay_run', archivedAt: null, cartridgeIds: cartridgeId }).select('_id').lean()) as any[];
	for (const g of groups) await evaluateAssayRunGroup(g._id);
	return groups.length;
}
