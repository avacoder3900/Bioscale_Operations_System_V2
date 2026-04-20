import { error, fail, redirect } from '@sveltejs/kit';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { createRobotClient, robotBaseUrl } from '$lib/server/opentrons/client';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

interface RobotDoc {
	_id: string;
	name: string;
	ip: string;
	port?: number;
}

async function getRobot(robotId: string): Promise<RobotDoc> {
	await connectDB();
	const robot = (await OpentronsRobot.findById(robotId)
		.select('_id name ip port')
		.lean()) as RobotDoc | null;
	if (!robot) throw error(404, 'Robot not found');
	return robot;
}

export const load: PageServerLoad = async ({ params }) => {
	const robot = await getRobot(params.robotId);
	const client = createRobotClient({ ip: robot.ip, port: robot.port }, { timeoutMs: 5000 });

	let protocol: any = null;
	let analyses: any[] = [];
	let latestAnalysis: any = null;
	let dataFiles: any[] = [];
	let instruments: any[] = [];
	let online = true;
	let dataFilesReachable = true;
	let instrumentsReachable = true;

	try {
		const detailRes = await (client as any).GET('/protocols/{protocolId}', {
			params: { path: { protocolId: params.protocolId } }
		});
		if (detailRes.error !== undefined) {
			if (detailRes.response.status === 404) throw error(404, 'Protocol not found');
			online = false;
		} else {
			protocol = detailRes.data?.data ?? null;
		}

		const analysesRes = await (client as any).GET('/protocols/{protocolId}/analyses', {
			params: { path: { protocolId: params.protocolId } }
		});
		if (analysesRes.error === undefined) {
			analyses = analysesRes.data?.data ?? [];
			if (analyses.length > 0) {
				const latest = analyses[analyses.length - 1];
				if (latest?.id) {
					const detailAnalysisRes = await (client as any).GET(
						'/protocols/{protocolId}/analyses/{analysisId}',
						{ params: { path: { protocolId: params.protocolId, analysisId: latest.id } } }
					);
					if (detailAnalysisRes.error === undefined) {
						latestAnalysis = detailAnalysisRes.data?.data ?? null;
					}
				}
			}
		}
	} catch (e: any) {
		if (e?.status) throw e;
		online = false;
	}

	try {
		const res = await (client as any).GET('/dataFiles', {});
		if (res.error !== undefined) dataFilesReachable = false;
		else dataFiles = res.data?.data ?? [];
	} catch {
		dataFilesReachable = false;
	}

	try {
		const res = await (client as any).GET('/instruments', {});
		if (res.error !== undefined) instrumentsReachable = false;
		else instruments = res.data?.data ?? [];
	} catch {
		instrumentsReachable = false;
	}

	return {
		robot: JSON.parse(JSON.stringify(robot)),
		protocolId: params.protocolId,
		online,
		protocol: JSON.parse(JSON.stringify(protocol)),
		analyses: JSON.parse(JSON.stringify(analyses)),
		latestAnalysis: JSON.parse(JSON.stringify(latestAnalysis)),
		dataFiles: JSON.parse(JSON.stringify(dataFiles)),
		dataFilesReachable,
		instruments: JSON.parse(JSON.stringify(instruments)),
		instrumentsReachable
	};
};

type RtpParam = {
	variableName: string;
	displayName: string;
	type: 'int' | 'float' | 'bool' | 'str' | 'csv_file';
	default?: number | boolean | string;
	value?: number | boolean | string;
	min?: number;
	max?: number;
	choices?: Array<{ displayName: string; value: number | string }>;
	file?: { id: string; name: string } | null;
};

function validateRtpValues(
	params: RtpParam[],
	rawValues: Record<string, unknown>
): { values: Record<string, number | boolean | string> } | { error: string } {
	const out: Record<string, number | boolean | string> = {};
	for (const [key, raw] of Object.entries(rawValues)) {
		const p = params.find((x) => x.variableName === key);
		if (!p) return { error: `Unknown runtime parameter: ${key}` };

		if (p.type === 'csv_file') {
			return { error: `CSV parameter ${key} must be submitted via rtpFiles, not rtpValues` };
		}

		if (p.type === 'bool') {
			if (typeof raw !== 'boolean') return { error: `${key}: expected boolean` };
			out[key] = raw;
			continue;
		}

		if (Array.isArray(p.choices)) {
			const allowed = p.choices.map((c) => c.value);
			const coerced =
				p.type === 'str'
					? String(raw)
					: p.type === 'int'
						? parseInt(String(raw), 10)
						: parseFloat(String(raw));
			if (p.type !== 'str' && !Number.isFinite(coerced as number)) {
				return { error: `${key}: expected ${p.type}, got ${JSON.stringify(raw)}` };
			}
			if (!allowed.some((v) => v === coerced)) {
				return { error: `${key}: value ${JSON.stringify(coerced)} not among allowed choices` };
			}
			out[key] = coerced as number | string;
			continue;
		}

		if (p.type === 'int') {
			const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
			if (!Number.isInteger(n)) return { error: `${key}: expected integer` };
			if (typeof p.min === 'number' && n < p.min) return { error: `${key}: below min ${p.min}` };
			if (typeof p.max === 'number' && n > p.max) return { error: `${key}: above max ${p.max}` };
			out[key] = n;
			continue;
		}

		if (p.type === 'float') {
			const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
			if (!Number.isFinite(n)) return { error: `${key}: expected number` };
			if (typeof p.min === 'number' && n < p.min) return { error: `${key}: below min ${p.min}` };
			if (typeof p.max === 'number' && n > p.max) return { error: `${key}: above max ${p.max}` };
			out[key] = n;
			continue;
		}

		return { error: `${key}: unsupported parameter type ${p.type}` };
	}
	return { values: out };
}

function validateRtpFiles(
	params: RtpParam[],
	rawFiles: Record<string, unknown>,
	knownFileIds: Set<string>
): { files: Record<string, string> } | { error: string } {
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(rawFiles)) {
		const p = params.find((x) => x.variableName === key);
		if (!p) return { error: `Unknown runtime parameter: ${key}` };
		if (p.type !== 'csv_file') {
			return { error: `${key}: rtpFiles is only valid for csv_file parameters` };
		}
		if (raw === null || raw === '' || raw === undefined) continue; // operator picked "none"
		if (typeof raw !== 'string') return { error: `${key}: expected fileId string` };
		if (knownFileIds.size > 0 && !knownFileIds.has(raw)) {
			return { error: `${key}: CSV file no longer exists; refresh and re-pick` };
		}
		out[key] = raw;
	}
	return { files: out };
}

export const actions: Actions = {
	delete: async ({ params, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		const robot = await getRobot(params.robotId);

		try {
			const res = await fetch(
				`${robotBaseUrl(robot)}/protocols/${encodeURIComponent(params.protocolId as string)}`,
				{
					method: 'DELETE',
					headers: { 'opentrons-version': '*' },
					signal: AbortSignal.timeout(10_000)
				}
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				return fail(res.status, { error: 'Delete failed', details: err });
			}
		} catch (e) {
			return fail(502, { error: `Robot unreachable: ${(e as Error).message}` });
		}

		throw redirect(303, `/opentrons-clone/${params.robotId}/protocols`);
	},

	createRun: async ({ params, request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		const robot = await getRobot(params.robotId);
		const client = createRobotClient({ ip: robot.ip, port: robot.port }, { timeoutMs: 5000 });

		const form = await request.formData();
		const rtpValuesRaw = form.get('rtpValues')?.toString() ?? '';
		const rtpFilesRaw = form.get('rtpFiles')?.toString() ?? '';

		let rtpValuesParsed: Record<string, unknown> = {};
		let rtpFilesParsed: Record<string, unknown> = {};
		if (rtpValuesRaw) {
			try {
				const parsed = JSON.parse(rtpValuesRaw);
				if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
					return fail(400, { error: 'rtpValues must be a JSON object' });
				}
				rtpValuesParsed = parsed as Record<string, unknown>;
			} catch {
				return fail(400, { error: 'rtpValues must be valid JSON' });
			}
		}
		if (rtpFilesRaw) {
			try {
				const parsed = JSON.parse(rtpFilesRaw);
				if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
					return fail(400, { error: 'rtpFiles must be a JSON object' });
				}
				rtpFilesParsed = parsed as Record<string, unknown>;
			} catch {
				return fail(400, { error: 'rtpFiles must be valid JSON' });
			}
		}

		let rtpValues: Record<string, number | boolean | string> = {};
		let rtpFiles: Record<string, string> = {};
		if (Object.keys(rtpValuesParsed).length > 0 || Object.keys(rtpFilesParsed).length > 0) {
			let params_: RtpParam[] = [];
			try {
				const analysesRes = await (client as any).GET('/protocols/{protocolId}/analyses', {
					params: { path: { protocolId: params.protocolId } }
				});
				if (analysesRes.error === undefined) {
					const analyses = analysesRes.data?.data ?? [];
					const latest = analyses[analyses.length - 1];
					if (latest?.id) {
						const detailRes = await (client as any).GET(
							'/protocols/{protocolId}/analyses/{analysisId}',
							{ params: { path: { protocolId: params.protocolId, analysisId: latest.id } } }
						);
						if (detailRes.error === undefined) {
							params_ = (detailRes.data?.data?.runTimeParameters ?? []) as RtpParam[];
						}
					}
				}
			} catch {
				return fail(502, { error: 'Could not fetch analysis to validate parameters' });
			}

			const vResult = validateRtpValues(params_, rtpValuesParsed);
			if ('error' in vResult) return fail(400, { error: vResult.error });
			rtpValues = vResult.values;

			let knownFileIds = new Set<string>();
			try {
				const dfRes = await (client as any).GET('/dataFiles', {});
				if (dfRes.error === undefined) {
					knownFileIds = new Set<string>(
						((dfRes.data?.data ?? []) as Array<{ id: string }>).map((f) => f.id)
					);
				}
			} catch {
				// Keep empty set — skip verification but still require type checks.
			}

			const fResult = validateRtpFiles(params_, rtpFilesParsed, knownFileIds);
			if ('error' in fResult) return fail(400, { error: fResult.error });
			rtpFiles = fResult.files;
		}

		const body: Record<string, unknown> = { protocolId: params.protocolId };
		if (Object.keys(rtpValues).length > 0) body.runTimeParameterValues = rtpValues;
		if (Object.keys(rtpFiles).length > 0) body.runTimeParameterFiles = rtpFiles;

		let runId: string | null = null;
		try {
			const res = await fetch(`${robotBaseUrl(robot)}/runs`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'opentrons-version': '*' },
				body: JSON.stringify({ data: body }),
				signal: AbortSignal.timeout(15_000)
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				return fail(res.status, { error: 'Run create failed', details: err });
			}
			const data = await res.json();
			runId = data?.data?.id ?? null;
		} catch (e) {
			return fail(502, { error: `Robot unreachable: ${(e as Error).message}` });
		}

		if (runId) throw redirect(303, `/opentrons-clone/${params.robotId}/runs/${runId}`);
		return fail(500, { error: 'Run created but no id returned' });
	}
};
