import { error, fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, AuditLog, generateId } from '$lib/server/db';
import { loadScreenCriteria } from '$lib/server/screen/ingest';
import { summarizeSession } from '$lib/server/screen/summarize';
import { appendSpuJournal } from '$lib/server/spu-journal';
import type { Actions, PageServerLoad } from './$types';

/** One screen in full: every row by level, the summary, the level-2 background records. */
export const load: PageServerLoad = async ({ params, locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();
	const s = (await ValidationSession.findById(params.sessionId).lean()) as any;
	if (!s || s.type !== 'screen') throw error(404, 'Screen session not found');
	const criteria = await loadScreenCriteria();
	const session = summarizeSession(s, criteria);
	// Full records (readings) only on the detail page.
	const records = Object.values(s.rawData?.records ?? {}).map((r: any) => ({
		runIndex: r.runIndex,
		assayId: r.assayId,
		startTime: r.startTime,
		durationS: r.durationS,
		numberOfReadings: r.numberOfReadings,
		stageCheck: r.stageCheck ?? null,
		background: r.background ?? null,
		// Per-channel clear vs reading number for a quick empty-slot trace.
		trace: ['A', 'B', 'C'].map((ch) => ({ ch, pts: (r.readings ?? []).filter((x: any) => x.channel === ch).map((x: any) => [x.number, x.clear, x.f3, x.f7, x.laser_output]) }))
	}));
	return { session: JSON.parse(JSON.stringify(session)), records: JSON.parse(JSON.stringify(records)) };
};

const VERDICTS = ['accepted', 'rejected', 'rerun'] as const;

export const actions: Actions = {
	/**
	 * A person's sign-off on the full report. Does not change the device's
	 * verdict or the unit's screen rollup — it records that someone read the
	 * rows and what they concluded (journal + audit).
	 */
	review: async ({ params, request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const verdict = form.get('verdict')?.toString() ?? '';
		const notes = form.get('notes')?.toString().trim().slice(0, 2000) ?? '';
		if (!(VERDICTS as readonly string[]).includes(verdict)) return fail(400, { error: 'Pick accepted, rejected or re-run' });
		if (verdict !== 'accepted' && !notes) return fail(400, { error: 'Say why when rejecting or asking for a re-run' });
		const s = (await ValidationSession.findById(params.sessionId).select('_id type spuId spuUdi rawData.run overallPassed review').lean()) as any;
		if (!s || s.type !== 'screen') return fail(404, { error: 'Screen session not found' });

		const who = { _id: locals.user!._id, username: locals.user!.username };
		const now = new Date();
		const review = { by: who, at: now, verdict, notes: notes || null };
		await ValidationSession.updateOne({ _id: s._id }, { $set: { review } });
		await AuditLog.create({
			_id: generateId(),
			tableName: 'validation_sessions',
			recordId: s._id,
			action: 'screen_review',
			oldData: s.review ?? null,
			newData: review,
			reason: `Screen report reviewed: ${verdict}`,
			changedBy: who.username ?? who._id,
			changedAt: now
		});
		if (s.spuId) {
			await appendSpuJournal(
				s.spuId,
				`Screen report ${verdict}${notes ? ' — ' + notes : ''} (run ${s.rawData?.run ?? '?'}, device ${s.overallPassed ? 'passed' : 'failed'})`,
				who,
				{ source: 'validation', refKind: 'validation_session', refId: s._id, refLabel: 'Screen' }
			);
		}
		return { reviewed: verdict };
	},

	clearReview: async ({ params, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const s = (await ValidationSession.findById(params.sessionId).select('_id type review').lean()) as any;
		if (!s || s.type !== 'screen') return fail(404, { error: 'Screen session not found' });
		await ValidationSession.updateOne({ _id: s._id }, { $set: { review: null } });
		await AuditLog.create({
			_id: generateId(),
			tableName: 'validation_sessions',
			recordId: s._id,
			action: 'screen_review',
			oldData: s.review ?? null,
			newData: null,
			reason: 'Screen report review cleared',
			changedBy: locals.user!.username ?? locals.user!._id,
			changedAt: new Date()
		});
		return { reviewed: null };
	}
};
