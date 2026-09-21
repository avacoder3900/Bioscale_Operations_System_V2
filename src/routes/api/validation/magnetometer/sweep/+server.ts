import { json } from '@sveltejs/kit';
import { connectDB, Spu, AuditLog, generateId } from '$lib/server/db';
import { ingestMagnetValidation, resolveLastActiveUser } from '$lib/server/magnetometer-ingest';
import type { RequestHandler } from './$types';

export const config = {
	maxDuration: 60
};

/**
 * Server-side magnetometer capture sweep.
 *
 * Reads magnet_validation off each target device and stores a ValidationSession
 * when the data is new, with no browser session involved — this is the path that
 * lets a run performed on the bench get recorded without anyone sitting on
 * /validation/magnetometer with the page open.
 *
 * Auth is API-key only (x-api-key / x-agent-api-key against AGENT_API_KEY);
 * there is no cron wiring, so nothing fires unless something calls this.
 *
 * Scope defaults to unit 253 and widens by parameter:
 *   { "udi": "BT-M01-0000-0253" }   explicit unit (repeatable via "udis": [...])
 *   { "spuId": "..." }               explicit SPU _id
 *   { "all": true }                  every SPU carrying a Particle device id
 */
const DEFAULT_SWEEP_UDI = 'BT-M01-0000-0253';

async function handleSweep(params: {
	udi?: string;
	udis?: string[];
	spuId?: string;
	all?: boolean;
}) {
	await connectDB();

	// Build the target set. Anything without a Particle device id can't be read,
	// so it never enters the list.
	const query: Record<string, unknown> = { 'particleLink.particleDeviceId': { $exists: true, $ne: null } };

	if (params.all) {
		// no additional filter — whole fleet
	} else if (params.spuId) {
		query._id = params.spuId;
	} else if (params.udis?.length) {
		query.udi = { $in: params.udis };
	} else {
		query.udi = params.udi ?? DEFAULT_SWEEP_UDI;
	}

	const targets = await Spu.find(query)
		.select('_id udi particleLink.particleDeviceId')
		.lean() as any[];

	if (targets.length === 0) {
		return {
			ok: false,
			error: 'No SPUs matched with a Particle device id',
			query: params.all ? 'all' : (params.spuId ?? params.udis ?? params.udi ?? DEFAULT_SWEEP_UDI),
			swept: 0,
			results: []
		};
	}

	// Attribution for the stored sessions. See resolveLastActiveUser — this is
	// the most recently active BIMS session, which is the closest thing the
	// schema has to "whoever was last signed in". May be null.
	const actor = await resolveLastActiveUser();

	const results: any[] = [];
	let stored = 0;

	for (const spu of targets) {
		const particleDeviceId = spu.particleLink?.particleDeviceId;
		if (!particleDeviceId) continue;

		const result = await ingestMagnetValidation({
			spuId: spu._id,
			spuUdi: spu.udi,
			particleDeviceId,
			actor,
			source: 'auto-sweep'
		});

		if (result.status === 'new_result' && result.session) {
			stored++;
			// Every mutation gets an audit entry.
			await AuditLog.create({
				_id: generateId(),
				action: 'create',
				resourceType: 'validation_session',
				resourceId: result.session.id,
				userId: actor?._id ?? null,
				username: actor?.username ?? 'system:mag-sweep',
				timestamp: new Date(),
				details: {
					via: 'magnetometer-sweep',
					spuId: spu._id,
					spuUdi: spu.udi,
					particleDeviceId,
					overallPassed: result.session.overallPassed,
					testRanAt: result.session.testRanAt,
					attribution: actor ? 'last-active-user' : 'none'
				}
			});
		}

		results.push({
			spuId: spu._id,
			udi: spu.udi,
			status: result.status,
			error: result.error ?? null,
			sessionId: result.session?.id ?? null,
			overallPassed: result.session?.overallPassed ?? null,
			fieldSummary: result.session?.fieldSummary ?? null
		});
	}

	return {
		ok: true,
		swept: targets.length,
		stored,
		attributedTo: actor ? { _id: actor._id, username: actor.username } : null,
		results
	};
}

function authorized(request: Request): boolean {
	const apiKey = request.headers.get('x-api-key') || request.headers.get('x-agent-api-key');
	return !!process.env.AGENT_API_KEY && apiKey === process.env.AGENT_API_KEY;
}

export const POST: RequestHandler = async ({ request }) => {
	if (!authorized(request)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	let body: any = {};
	try {
		body = await request.json();
	} catch {
		// empty body is fine — falls through to the default target
	}

	const result = await handleSweep({
		udi: body.udi,
		udis: body.udis,
		spuId: body.spuId,
		all: body.all === true
	});

	return json(result, result.ok ? undefined : { status: 404 });
};

/** GET form so the sweep can be triggered with a plain curl. */
export const GET: RequestHandler = async ({ request, url }) => {
	if (!authorized(request)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const result = await handleSweep({
		udi: url.searchParams.get('udi') ?? undefined,
		spuId: url.searchParams.get('spuId') ?? undefined,
		all: url.searchParams.get('all') === 'true'
	});

	return json(result, result.ok ? undefined : { status: 404 });
};
