import { error, fail, redirect } from '@sveltejs/kit';
import { requirePermission, hasPermission } from '$lib/server/permissions';
import { connectDB, TestResult } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'testResult:read');
	await connectDB();

	const raw = await TestResult.findById(params.resultId).lean();
	if (!raw) throw error(404, 'Test result not found');
	const r = raw as any;

	const canWrite = hasPermission(locals.user, 'testResult:write') || hasPermission(locals.user, 'admin:full');

	return {
		result: {
			id: r._id,
			cartridgeUuid: r.cartridgeUuid ?? null,
			assayId: r.assayId ?? null,
			deviceId: r.deviceId ?? null,
			dataFormatCode: r.dataFormatCode ?? null,
			startTime: r.startTime ?? null,
			duration: r.duration ?? null,
			astep: r.astep ?? null,
			atime: r.atime ?? null,
			again: r.again ?? null,
			numberOfReadings: r.numberOfReadings ?? null,
			baselineScans: r.baselineScans ?? null,
			testScans: r.testScans ?? null,
			checksum: r.checksum ?? null,
			status: r.status ?? 'uploaded',
			processedAt: r.processedAt ?? null,
			createdAt: r.createdAt
		},
		readings: (r.readings ?? []).map((reading: any, idx: number) => ({
			id: `${r._id}-${idx}`,
			readingNumber: reading.readingNumber ?? idx + 1,
			channel: reading.channel ?? 'A',
			position: reading.position ?? 0,
			temperature: reading.temperature ?? null,
			laserOutput: reading.laserOutput ?? null,
			timestampMs: reading.timestampMs ?? 0,
			f1: reading.f1 ?? 0,
			f2: reading.f2 ?? 0,
			f3: reading.f3 ?? 0,
			f4: reading.f4 ?? 0,
			f5: reading.f5 ?? 0,
			f6: reading.f6 ?? 0,
			f7: reading.f7 ?? 0,
			f8: reading.f8 ?? 0,
			clearChannel: reading.clearChannel ?? 0,
			nirChannel: reading.nirChannel ?? 0
		})),
		canWrite
	};
};

export const actions: Actions = {
	updateStatus: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'testResult:write');
		await connectDB();
		const form = await request.formData();
		const status = form.get('status')?.toString();
		if (!status) return fail(400, { error: 'Status required' });

		await TestResult.updateOne({ _id: params.resultId }, { $set: { status } });
		return { success: true };
	}
};

export const config = { maxDuration: 60 };
