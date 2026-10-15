/**
 * Cloud-uploaded magnetometer sweep → validation_sessions (type 'mag_sweep'),
 * shaped exactly like the 32 serial-captured sessions so the magnetometer
 * pages and the Sept 25 analysis read both alike.
 *
 * Pass/fail: `mag_criteria` may carry `minGradient` and/or `minForceIndex`
 * (per lane floors from TASK-172). When either is set the sweep is judged and
 * the unit's validation.magnetometer rollup is written; with neither set the
 * session is stored as information only and the fixed-point mag test remains
 * the gate.
 */
import { connectDB, Spu, ValidationSession, Integration, AuditLog, generateId } from '$lib/server/db';
import { appendSpuJournal } from '$lib/server/spu-journal';
import { autoEnterValidating } from '$lib/server/spu-auto-validate';
import { parseSweepText } from './parse';
import { analyzeSweep } from './analyze';

export async function ingestSweepText(particleDeviceId: string, chunkId: string, text: string, receivedAt: Date): Promise<{ sessionId: string } | { error: string }> {
	const parsed = parseSweepText(text);
	if ('error' in parsed) return parsed;
	await connectDB();
	const spu = (await Spu.findOne({ 'particleLink.particleDeviceId': particleDeviceId }).select('_id udi finalizedAt').lean()) as any;
	const analysis = analyzeSweep(parsed.fields, parsed.rows, {
		rowsReported: parsed.end?.rows ?? parsed.meta.points * parsed.meta.wells,
		goodReported: parsed.end?.good,
		rowsMissing: parsed.rowsMissing,
		durationMs: parsed.end?.ms ?? null,
		travelLimit: 40000
	});

	const criteria = ((await Integration.findOne({ type: 'mag_criteria' }).lean()) as any) ?? {};
	const minGradient = Number.isFinite(Number(criteria.minGradient)) ? Number(criteria.minGradient) : null;
	const minForceIndex = Number.isFinite(Number(criteria.minForceIndex)) ? Number(criteria.minForceIndex) : null;
	const judged = minGradient != null || minForceIndex != null;
	const failureReasons: string[] = [];
	if (judged) {
		for (const w of analysis.wellNumbers) {
			for (const ch of analysis.channels) {
				const r = analysis.wells[String(w)]?.[ch];
				if (!r) {
					failureReasons.push(`well ${w}${ch}: not sampled`);
					continue;
				}
				if (r.peakUnreliable) failureReasons.push(`well ${w}${ch}: ${r.reasons.join('; ')}`);
				if (minGradient != null && r.gradBzdz != null && r.gradBzdz < minGradient) failureReasons.push(`well ${w}${ch}: gradient ${r.gradBzdz} below ${minGradient}`);
				if (minForceIndex != null && r.forceIndex != null && r.forceIndex < minForceIndex) failureReasons.push(`well ${w}${ch}: force index ${r.forceIndex} below ${minForceIndex}`);
			}
		}
		if (!analysis.coverageComplete) failureReasons.push(`${analysis.rowsMissing} rows missing from the upload`);
	}
	const overallPassed = judged ? failureReasons.length === 0 : null;
	// The device's id is its epoch at sweep start — when the sweep ran.
	const idNum = Number(parsed.meta.id ?? chunkId);
	const testRanAt = Number.isFinite(idNum) && idNum > 1_600_000_000 ? new Date(idNum * 1000) : null;

	const sessionId = generateId();
	await ValidationSession.create({
		_id: sessionId,
		type: 'mag_sweep',
		spuId: spu?._id ?? null,
		spuUdi: spu?.udi ?? null,
		particleDeviceId,
		status: judged ? (overallPassed ? 'completed' : 'failed') : 'completed',
		startedAt: receivedAt,
		completedAt: receivedAt,
		testRanAt,
		rawData: { ...parsed, sourceFile: `cloud:${chunkId}` },
		magResults: analysis,
		overallPassed,
		failureReasons,
		criteriaUsed: judged ? { minGradient, minForceIndex } : null,
		results: [
			{
				_id: generateId(),
				testType: 'magnetometer_sweep',
				rawData: null,
				processedData: { wells: analysis.wells, wellNumbers: analysis.wellNumbers, minGradient: analysis.minGradient, minForceIndex: analysis.minForceIndex },
				passed: overallPassed,
				notes: `Cloud upload ${chunkId}, ${parsed.rows.length} rows${parsed.meta.seg > 1 ? `, ${parsed.meta.seg} segments` : ''}`,
				createdAt: receivedAt
			}
		]
	});

	if (judged && spu && !spu.finalizedAt) {
		const status = overallPassed ? 'passed' : 'failed';
		await Spu.updateOne(
			{ _id: spu._id },
			{
				$set: {
					'validation.magnetometer': {
						status,
						sessionId,
						completedAt: receivedAt,
						testRanAt,
						rawData: { source: 'mag_sweep', chunkId, meta: parsed.meta },
						results: analysis.wells,
						failureReasons,
						criteriaUsed: { minGradient, minForceIndex }
					}
				}
			}
		);
		await autoEnterValidating(spu._id, 'magnetometer');
		await AuditLog.create({
			_id: generateId(),
			tableName: 'spus',
			recordId: spu._id,
			action: 'UPDATE',
			oldData: null,
			newData: { validationType: 'magnetometer', source: 'mag_sweep', status, sessionId, failureReasons },
			changedAt: receivedAt,
			changedBy: 'particle-webhook',
			reason: `Magnet sweep ${status.toUpperCase()}${failureReasons.length ? ' — ' + failureReasons.slice(0, 3).join('; ') : ''}`
		});
	}
	if (spu) {
		const g = analysis.minGradient;
		await appendSpuJournal(
			spu._id,
			`Magnet sweep uploaded (${parsed.meta.seg > 1 ? 'peaks-only' : 'full'}, ${parsed.rows.length} rows)${g ? ` — min gradient ${g.value} at well ${g.well}${g.channel}` : ''}${judged ? ` — ${overallPassed ? 'passed' : 'failed'}` : ''}`,
			{ _id: 'system:particle-webhook', username: 'particle-webhook' },
			{ source: 'validation', refKind: 'validation_session', refId: sessionId, refLabel: 'Magnet sweep' }
		);
	}
	return { sessionId };
}
