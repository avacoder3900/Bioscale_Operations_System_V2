/**
 * Form actions split out so +page.server.ts stays focused on load.
 * Imported + spread into the route's `export const actions` below.
 */
import { fail } from '@sveltejs/kit';
import {
	connectDB, ProcessAnalyticsEvent, FmeaRecord, SpcSignal, SpecLimit,
	CauseEffectDiagram, AuditLog, generateId
} from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { Actions } from './$types';

function userRef(locals: any) {
	return { _id: locals.user?._id ?? 'system', username: locals.user?.username ?? 'system' };
}

async function writeAudit(opts: {
	tableName: string; recordId: string; action: string; changedBy: string;
	reason?: string; newData?: any;
}) {
	await AuditLog.create({
		_id: generateId(),
		tableName: opts.tableName,
		recordId: opts.recordId,
		action: opts.action,
		changedBy: opts.changedBy,
		changedAt: new Date(),
		reason: opts.reason,
		newData: opts.newData
	}).catch(() => {});
}

export const analysisActions: Actions = {
	// -----------------------------------------------------------------------
	// Manual input
	// -----------------------------------------------------------------------
	createManualEvent: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const f = await request.formData();
		const notes = f.get('notes')?.toString().trim() ?? '';
		if (!notes) return fail(400, { error: 'Notes are required' });

		const eventType = f.get('eventType')?.toString() ?? 'observation';
		const processType = f.get('processType')?.toString() ?? 'general';
		const occurredAtRaw = f.get('occurredAt')?.toString();
		const occurredAt = occurredAtRaw ? new Date(occurredAtRaw) : new Date();

		const numericRaw = f.get('numericValue')?.toString();
		const numericValue = numericRaw && !isNaN(Number(numericRaw)) ? Number(numericRaw) : undefined;

		const doc = await ProcessAnalyticsEvent.create({
			_id: generateId(),
			eventType,
			processType,
			occurredAt,
			operator: userRef(locals),
			linkedRunId: f.get('linkedRunId')?.toString() || undefined,
			linkedLotId: f.get('linkedLotId')?.toString() || undefined,
			linkedEquipmentId: f.get('linkedEquipmentId')?.toString() || undefined,
			linkedCartridgeIds: (f.get('linkedCartridgeIds')?.toString() ?? '').split(',').map(s => s.trim()).filter(Boolean),
			numericValue,
			numericUnit: f.get('numericUnit')?.toString() || undefined,
			categoricalValue: f.get('categoricalValue')?.toString() || undefined,
			rejectionReasonCode: f.get('rejectionReasonCode')?.toString() || undefined,
			severity: f.get('severity')?.toString() || undefined,
			notes,
			createdBy: userRef(locals),
			updatedBy: userRef(locals)
		});

		await writeAudit({
			tableName: 'process_analytics_events',
			recordId: String(doc._id),
			action: 'INSERT',
			changedBy: locals.user.username ?? '',
			reason: `Manual event: ${eventType} on ${processType}`,
			newData: { eventType, processType, notes, numericValue }
		});

		return { success: true, eventId: String(doc._id) };
	},

	deleteManualEvent: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const f = await request.formData();
		const id = f.get('id')?.toString();
		if (!id) return fail(400, { error: 'id required' });
		await ProcessAnalyticsEvent.findByIdAndDelete(id);
		await writeAudit({ tableName: 'process_analytics_events', recordId: id, action: 'DELETE', changedBy: locals.user.username ?? '' });
		return { success: true };
	},

	// -----------------------------------------------------------------------
	// FMEA
	// -----------------------------------------------------------------------
	saveFmea: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();
		const f = await request.formData();
		const id = f.get('id')?.toString() || generateId();
		const body: any = {
			_id: id,
			processType: f.get('processType')?.toString() ?? 'general',
			processStep: f.get('processStep')?.toString() || undefined,
			failureMode: f.get('failureMode')?.toString() ?? '',
			failureEffect: f.get('failureEffect')?.toString() || undefined,
			cause: f.get('cause')?.toString() || undefined,
			currentControls: f.get('currentControls')?.toString() || undefined,
			severity: Number(f.get('severity') ?? 0),
			occurrence: Number(f.get('occurrence') ?? 0),
			detection: Number(f.get('detection') ?? 0),
			classification: f.get('classification')?.toString() || undefined,
			status: f.get('status')?.toString() ?? 'draft',
			createdBy: userRef(locals)
		};
		if (!body.failureMode) return fail(400, { error: 'Failure mode required' });
		body.rpn = body.severity * body.occurrence * body.detection;
		await FmeaRecord.findByIdAndUpdate(id, body, { upsert: true, new: true });
		await writeAudit({ tableName: 'fmea_records', recordId: id, action: 'UPSERT', changedBy: locals.user.username ?? '', newData: body });
		return { success: true, id };
	},

	deleteFmea: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();
		const f = await request.formData();
		const id = f.get('id')?.toString();
		if (!id) return fail(400, { error: 'id required' });
		await FmeaRecord.findByIdAndUpdate(id, { status: 'archived' });
		await writeAudit({ tableName: 'fmea_records', recordId: id, action: 'ARCHIVE', changedBy: locals.user.username ?? '' });
		return { success: true };
	},

	// -----------------------------------------------------------------------
	// Spec limits
	// -----------------------------------------------------------------------
	saveSpecLimit: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();
		const f = await request.formData();
		const id = f.get('id')?.toString() || generateId();
		const doc: any = {
			_id: id,
			processType: f.get('processType')?.toString() ?? 'general',
			metric: f.get('metric')?.toString() ?? '',
			metricLabel: f.get('metricLabel')?.toString() || undefined,
			unit: f.get('unit')?.toString() || undefined,
			LSL: f.get('LSL') ? Number(f.get('LSL')) : null,
			USL: f.get('USL') ? Number(f.get('USL')) : null,
			target: f.get('target') ? Number(f.get('target')) : null,
			cpkMin: f.get('cpkMin') ? Number(f.get('cpkMin')) : 1.33,
			rationale: f.get('rationale')?.toString() ?? '',
			approvedBy: userRef(locals),
			approvedAt: new Date(),
			active: true
		};
		if (!doc.metric) return fail(400, { error: 'metric required' });
		if (!doc.rationale) return fail(400, { error: 'Rationale is required for regulatory traceability' });
		await SpecLimit.findByIdAndUpdate(id, doc, { upsert: true, new: true });
		await writeAudit({ tableName: 'spec_limits', recordId: id, action: 'UPSERT', changedBy: locals.user.username ?? '', newData: doc });
		return { success: true, id };
	},

	retireSpecLimit: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();
		const f = await request.formData();
		const id = f.get('id')?.toString();
		if (!id) return fail(400, { error: 'id required' });
		await SpecLimit.findByIdAndUpdate(id, { active: false });
		await writeAudit({ tableName: 'spec_limits', recordId: id, action: 'RETIRE', changedBy: locals.user.username ?? '' });
		return { success: true };
	},

	// -----------------------------------------------------------------------
	// SPC signals
	// -----------------------------------------------------------------------
	ackSignal: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const f = await request.formData();
		const id = f.get('id')?.toString();
		if (!id) return fail(400, { error: 'id required' });
		await SpcSignal.findByIdAndUpdate(id, {
			status: 'acknowledged',
			acknowledgedBy: userRef(locals),
			acknowledgedAt: new Date()
		});
		await writeAudit({ tableName: 'spc_signals', recordId: id, action: 'ACK', changedBy: locals.user.username ?? '' });
		return { success: true };
	},

	closeSignal: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const f = await request.formData();
		const id = f.get('id')?.toString();
		if (!id) return fail(400, { error: 'id required' });
		const rootCause = f.get('rootCause')?.toString() ?? '';
		const correctiveAction = f.get('correctiveAction')?.toString() ?? '';
		if (!rootCause || !correctiveAction) return fail(400, { error: 'Root cause + corrective action are required' });
		await SpcSignal.findByIdAndUpdate(id, {
			status: 'closed',
			rootCause,
			correctiveAction,
			closedBy: userRef(locals),
			closedAt: new Date()
		});
		await writeAudit({ tableName: 'spc_signals', recordId: id, action: 'CLOSE', changedBy: locals.user.username ?? '', newData: { rootCause, correctiveAction } });
		return { success: true };
	},

	dismissSignal: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();
		const f = await request.formData();
		const id = f.get('id')?.toString();
		if (!id) return fail(400, { error: 'id required' });
		const dismissReason = f.get('dismissReason')?.toString() ?? '';
		if (!dismissReason) return fail(400, { error: 'Dismiss reason required' });
		await SpcSignal.findByIdAndUpdate(id, {
			status: 'dismissed',
			dismissReason,
			closedBy: userRef(locals),
			closedAt: new Date()
		});
		await writeAudit({ tableName: 'spc_signals', recordId: id, action: 'DISMISS', changedBy: locals.user.username ?? '', newData: { dismissReason } });
		return { success: true };
	},

	// -----------------------------------------------------------------------
	// Cause & Effect
	// -----------------------------------------------------------------------
	saveCauseEffect: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const f = await request.formData();
		const id = f.get('id')?.toString() || generateId();
		let nodes: any[] = [];
		try { nodes = JSON.parse(f.get('nodes')?.toString() ?? '[]'); } catch { return fail(400, { error: 'Invalid nodes JSON' }); }
		const doc: any = {
			_id: id,
			processType: f.get('processType')?.toString() ?? 'general',
			problemStatement: f.get('problemStatement')?.toString() ?? '',
			nodes,
			updatedBy: userRef(locals),
			active: true
		};
		if (!doc.problemStatement) return fail(400, { error: 'Problem statement required' });
		await CauseEffectDiagram.findByIdAndUpdate(id, doc, { upsert: true, new: true });
		await writeAudit({ tableName: 'cause_effect_diagrams', recordId: id, action: 'UPSERT', changedBy: locals.user.username ?? '' });
		return { success: true, id };
	}
};
