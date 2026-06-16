import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, Spu, LabCartridge, ManufacturingSettings, ValidationSession, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';

type Reading = { readingNumber: number; channel: string; value: number; timestampMs: number };

// Evaluate the multi-channel readings against the criteria range.
// For each criteria parameter we take the LAST reading (highest readingNumber) of its channel.
function evaluate(readings: Reading[], parameters: any[]) {
	const results = (parameters ?? []).map((p) => {
		const forChannel = readings.filter((r) => r.channel === p.channel);
		const last = forChannel.sort((a, b) => a.readingNumber - b.readingNumber).at(-1);
		const value = last ? last.value : null;
		const passed =
			value !== null &&
			(p.min == null || value >= p.min) &&
			(p.max == null || value <= p.max);
		return { name: p.name, channel: p.channel, unit: p.unit, value, min: p.min ?? null, max: p.max ?? null, passed };
	});
	const failureReasons = results
		.filter((r) => (parameters.find((p) => p.name === r.name)?.required ?? true) && !r.passed)
		.map((r) => `${r.name} (${r.channel}) = ${r.value} out of range [${r.min}, ${r.max}]`);
	return { results, overallPassed: failureReasons.length === 0 };
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'spu:write');
	await connectDB();

	const { spuId, readings } = await request.json();
	if (!spuId || !Array.isArray(readings) || readings.length === 0)
		return json({ error: 'spuId and a non-empty readings[] are required' }, { status: 400 });

	const spu = await Spu.findById(spuId);
	if (!spu) return json({ error: 'SPU not found' }, { status: 404 });
	if (spu.finalizedAt) return json({ error: 'SPU finalized - use corrections' }, { status: 400 });
	const oc = spu.validation?.opticalConfirmation;
	if (!oc?.labCartridgeId) return json({ error: 'No optical confirmation cartridge attached' }, { status: 400 });

	// Snapshot the active criteria range (so later range edits never rewrite this result).
	const settings = await ManufacturingSettings.findById('default').lean();
	const criteria = settings?.opticalConfirmation;
	if (!criteria?.parameters?.length)
		return json({ error: 'No optical confirmation criteria configured' }, { status: 400 });

	const { results, overallPassed } = evaluate(readings, criteria.parameters);
	const failureReasons = results.filter((r) => !r.passed).map((r) => `${r.name} out of range`);
	const criteriaUsed = { version: criteria.version ?? 1, parameters: criteria.parameters };
	const operator = { _id: locals.user._id, username: locals.user.username };
	const now = new Date();

	// 1) ValidationSession — the immutable record of this run
	const session = await ValidationSession.create({
		_id: generateId(),
		type: 'optical_confirmation',
		spuId: spu._id,
		spuUdi: spu.udi,
		status: overallPassed ? 'completed' : 'failed',
		startedAt: now,
		completedAt: now,
		userId: locals.user._id,
		barcode: oc.cartridgeBarcode,
		rawData: { readings },
		results: [{ _id: generateId(), testType: 'optical_confirmation', rawData: { readings }, processedData: results, passed: overallPassed, createdAt: now }],
		overallPassed,
		failureReasons,
		criteriaUsed
	});

	// 2) SPU validation sub-object — the current/latest result
	const ocPath = spu.validation.opticalConfirmation;
	ocPath.status = overallPassed ? 'passed' : 'failed';
	ocPath.sessionId = session._id;
	ocPath.completedAt = now;
	ocPath.rawData = { readings };
	ocPath.results = results;
	ocPath.criteriaUsed = criteriaUsed;
	ocPath.failureReasons = failureReasons;
	if (!overallPassed) spu.validation.status = 'failed';
	spu.markModified('validation.opticalConfirmation');
	await spu.save();

	// 3) Cartridge — consumed
	const cartridge = await LabCartridge.findById(oc.labCartridgeId);
	if (cartridge) {
		cartridge.status = 'depleted';
		cartridge.usageLog.push({ action: 'status_changed', previousValue: 'in_use', newValue: 'depleted', spuId: spu._id, validationSessionId: session._id, performedBy: operator, performedAt: now });
		await cartridge.save();
	}

	await AuditLog.create({
		tableName: 'spus', recordId: spu._id, action: 'UPDATE',
		newData: { opticalConfirmation: { status: ocPath.status, sessionId: session._id, overallPassed } },
		changedBy: locals.user._id, changedAt: now,
		reason: `Optical confirmation result: ${overallPassed ? 'passed' : 'failed'}`
	});

	return json({ success: true, sessionId: session._id, overallPassed, results });
};
