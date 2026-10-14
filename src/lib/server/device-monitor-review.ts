/**
 * Daily monitor review — for every SPU with monitoring.enabled, merge the
 * unified timeline (firmware log uploads that v103 monitor mode sends on its
 * own, webhook logs, crashes, events) with the test records of the window,
 * add the control units' numbers for comparison, and ask Claude for a verdict
 * in a fixed schema. Verdicts and findings persist in device_findings (no TTL);
 * the raw inputs expire on their own.
 *
 * Entry points: runDailyReview() from /api/cron/device-monitor-review and the
 * "Review now" button on /spu/monitor; reviewDevice() for one unit.
 * Spec: docs/device-monitor-mode.md.
 */
import Anthropic from '@anthropic-ai/sdk';
import mongoose from 'mongoose';
import { connectDB, Spu, DeviceFinding, generateId } from '$lib/server/db';
import { buildDeviceTimeline, timelineToText } from '$lib/server/device-timeline';

export const DEFAULT_REVIEW_MODEL = process.env.DEVICE_MONITOR_MODEL ?? 'claude-sonnet-4-6';

// USD per million tokens; unknown models cost null (still run, just unpriced).
const PRICING: Record<string, { input: number; output: number }> = {
	'claude-haiku-4-5': { input: 1.0, output: 5.0 },
	'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
	'claude-opus-4-7': { input: 5.0, output: 25.0 },
	'claude-sonnet-5-5': { input: 3.0, output: 15.0 },
	'claude-opus-5-5': { input: 5.0, output: 25.0 }
};

export interface MonitoredSpu {
	_id: string;
	udi: string;
	deviceId: string;
	role: 'suspect' | 'control';
	reason?: string;
	status?: string;
}

export interface ReviewFinding {
	title: string;
	severity: 'info' | 'warning' | 'error';
	category: string;
	detail: string;
	recommendation: string;
	confidence: number;
	evidence: { source: string; at?: string; text: string }[];
}

export interface ReviewVerdict {
	status: 'healthy' | 'watch' | 'suspect' | 'no_data';
	summary: string;
	findings: ReviewFinding[];
}

export interface ReviewResult {
	spuId: string;
	udi: string;
	deviceId: string;
	dayKey: string;
	status: ReviewVerdict['status'] | 'error';
	summary: string;
	findingCount: number;
	reviewId?: string;
	inputCounts: Record<string, number>;
	model?: string;
	costUsd?: number | null;
	durationMs: number;
	error?: string;
	prompt?: string; // dry runs only
}

export async function listMonitoredSpus(): Promise<MonitoredSpu[]> {
	await connectDB();
	const rows = (await Spu.find({ 'monitoring.enabled': true })
		.select('udi status particleLink monitoring')
		.lean()) as any[];
	return rows
		.filter((s) => s.particleLink?.particleDeviceId)
		.map((s) => ({
			_id: s._id,
			udi: s.udi,
			deviceId: s.particleLink.particleDeviceId,
			role: s.monitoring?.role === 'control' ? 'control' : 'suspect',
			reason: s.monitoring?.reason,
			status: s.status
		}));
}

// ---------- test records ----------

interface RecordSummary {
	serial: string;
	assayId: string;
	status: string;
	startedAt: string | null;
	durationS: number | null;
	readings: number | null;
	stage: any;
	outputs: any;
	warnings: string[];
	fw: number | null;
}

async function loadRecords(deviceId: string, from: Date, to: Date): Promise<RecordSummary[]> {
	const col = mongoose.connection.db!.collection('cartridge_records');
	const docs = await col
		.find(
			{ 'device.id': deviceId, updatedAt: { $gte: from, $lte: to }, rawData: { $exists: true } },
			{
				projection: {
					serialNumber: 1, assayId: 1, status: 1, updatedAt: 1,
					'rawData.startTime': 1, 'rawData.duration': 1, 'rawData.numberOfReadings': 1, 'rawData.stageCheck': 1,
					'analysis.outputs': 1, 'analysis.warnings': 1, 'device.firmware_version': 1, 'testResult.status': 1
				}
			}
		)
		.sort({ updatedAt: 1 })
		.limit(60)
		.toArray();
	return docs.map((d: any) => ({
		serial: d.serialNumber ?? d._id,
		assayId: d.assayId ?? '',
		status: d.testResult?.status ?? d.status ?? '',
		startedAt: d.rawData?.startTime ? new Date(Number(d.rawData.startTime) * (Number(d.rawData.startTime) < 1e12 ? 1000 : 1)).toISOString() : (d.updatedAt ? new Date(d.updatedAt).toISOString() : null),
		durationS: d.rawData?.duration ?? null,
		readings: d.rawData?.numberOfReadings ?? null,
		stage: d.rawData?.stageCheck ?? null,
		outputs: compactOutputs(d.analysis?.outputs),
		warnings: Array.isArray(d.analysis?.warnings) ? d.analysis.warnings.map((w: any) => (typeof w === 'string' ? w : w?.message ?? JSON.stringify(w))).slice(0, 5) : [],
		fw: d.device?.firmware_version ?? null
	}));
}

function compactOutputs(outputs: any): any {
	if (!outputs || typeof outputs !== 'object') return null;
	const out: Record<string, any> = {};
	let n = 0;
	for (const [k, v] of Object.entries(outputs)) {
		if (n++ >= 12) break;
		out[k] = typeof v === 'number' ? Number(v.toFixed(3)) : typeof v === 'object' && v && 'value' in (v as any) ? (v as any).value : v;
	}
	return out;
}

function recordsToText(recs: RecordSummary[]): string {
	if (recs.length === 0) return '(no test records in window)';
	return recs
		.map((r) => {
			const st = r.stage ? `stage{err=${r.stage.endErrorUm ?? r.stage.error ?? '?'}um hits=${r.stage.limitHits ?? '?'} found=${r.stage.switchFound ?? '?'}${r.stage.homeMs != null ? ` home=${r.stage.homeMs}ms` : ''}${r.stage.travelUm != null ? ` travel=${r.stage.travelUm}um` : ''}}` : 'stage{none}';
			return `${r.startedAt?.slice(5, 19).replace('T', ' ') ?? '?'} ${r.serial} assay=${r.assayId} status=${r.status} dur=${r.durationS ?? '?'}s readings=${r.readings ?? '?'} fw=${r.fw ?? '?'} ${st} outputs=${JSON.stringify(r.outputs)}${r.warnings.length ? ` warnings=${JSON.stringify(r.warnings)}` : ''}`;
		})
		.join('\n');
}

function controlsToText(controls: { udi: string; recs: RecordSummary[] }[]): string {
	if (controls.length === 0) return '(no control units configured)';
	return controls
		.map((c) => {
			const errs = c.recs.map((r) => r.stage?.endErrorUm ?? r.stage?.error).filter((v) => typeof v === 'number') as number[];
			const hits = c.recs.map((r) => r.stage?.limitHits).filter((v) => typeof v === 'number') as number[];
			const med = (a: number[]) => (a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
			const outputs = c.recs.map((r) => r.outputs).filter(Boolean);
			const keys = outputs.length ? Object.keys(outputs[0]).filter((k) => typeof outputs[0][k] === 'number').slice(0, 6) : [];
			const medOut = Object.fromEntries(keys.map((k) => [k, med(outputs.map((o) => o[k]).filter((v) => typeof v === 'number'))]));
			return `${c.udi}: ${c.recs.length} runs, stage err median ${med(errs)}um, limit hits total ${hits.reduce((a, b) => a + b, 0)}, output medians ${JSON.stringify(medOut)}`;
		})
		.join('\n');
}

// ---------- Claude ----------

const REVIEW_TOOL = {
	name: 'report_review',
	description: 'Report the review verdict for one device in the fixed schema. Always call this exactly once.',
	input_schema: {
		type: 'object' as const,
		additionalProperties: false,
		properties: {
			status: { type: 'string', enum: ['healthy', 'watch', 'suspect', 'no_data'] },
			summary: { type: 'string', description: 'Two to four sentences a device engineer can act on. Name the evidence.' },
			findings: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						title: { type: 'string' },
						severity: { type: 'string', enum: ['info', 'warning', 'error'] },
						category: { type: 'string', enum: ['stage', 'heater', 'cloud', 'optics', 'crash', 'assay', 'power', 'other'] },
						detail: { type: 'string' },
						recommendation: { type: 'string' },
						confidence: { type: 'number', minimum: 0, maximum: 1 },
						evidence: {
							type: 'array',
							items: {
								type: 'object',
								additionalProperties: false,
								properties: { source: { type: 'string' }, at: { type: 'string' }, text: { type: 'string' } },
								required: ['source', 'text']
							}
						}
					},
					required: ['title', 'severity', 'category', 'detail', 'recommendation', 'confidence', 'evidence']
				}
			}
		},
		required: ['status', 'summary', 'findings']
	}
};

const SYSTEM_PROMPT = `You review one Brevitest SPU (a cartridge-reading instrument: stepper stage with a limit switch, PID heater, three lasers, an AS7341 spectrometer, a Particle M-SoM radio) from one day of its own telemetry. You are the first reader; a device engineer reads what you write.

What the inputs are:
- "fw" lines are the firmware's own session log (ms|message). A "---- MONITOR <trigger> ----" block is a snapshot the firmware writes before each upload: trigger (test-complete, sonic-complete, screen, error, boot), mode, last_error, cloud/wifi/rssi, heater, stage position, last test id, and the last state transitions (T0 newest).
- "hook" lines are the cloud's record of each webhook (validate-cartridge, upload-test, device-log, ...) with status and latency.
- "CRASH" lines are checkpoint-trail crash detections (an even checkpoint means the operation it marks never finished).
- "ev" lines are events the cloud stored for this device.
- Test records list each run in the window with the stage check (end-of-test homing error in um, mid-move limit hits, home time, travel) and the analysis outputs.
- Control units are healthy instruments of the same build; use their numbers to tell "this unit is off" from "this assay/lot is off".

Rules:
- Only report what the evidence shows. Quote the line(s) in evidence. If the window is empty or only has routine lines, say healthy or no_data with an empty findings list.
- Severity: error = a failed or lost test, a crash, a stage error above 100 um or any limit hit, heater not reaching target, repeated cloud failures; warning = drift, one-off retries, odd timing, outputs away from the controls; info = worth a note only.
- Status: suspect if any error-severity finding; watch if warnings only; healthy otherwise.
- Keep recommendations physical and specific (re-seat the limit switch, run the magnet sweep, check the thermistor, re-flash) rather than generic.
- Never invent numbers. Never mention credentials.`;

function buildPrompt(args: {
	spu: MonitoredSpu;
	from: Date;
	to: Date;
	timelineText: string;
	timelineKept: number;
	timelineDropped: number;
	recordsText: string;
	controlsText: string;
	priorSummary: string | null;
}): string {
	return [
		`Device ${args.spu.udi} (Particle ${args.spu.deviceId}), role ${args.spu.role}${args.spu.reason ? `, watched because: ${args.spu.reason}` : ''}, SPU status ${args.spu.status ?? '?'}.`,
		`Window ${args.from.toISOString()} to ${args.to.toISOString()} (UTC).`,
		args.priorSummary ? `Previous review said: ${args.priorSummary}` : 'No previous review.',
		'',
		`== Timeline (${args.timelineKept} lines kept, ${args.timelineDropped} routine lines omitted) ==`,
		args.timelineText || '(nothing in window)',
		'',
		'== Test records in window ==',
		args.recordsText,
		'',
		'== Control units, same window ==',
		args.controlsText,
		'',
		'Call report_review once with your verdict.'
	].join('\n');
}

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
	if (_client) return _client;
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) return null;
	_client = new Anthropic({ apiKey });
	return _client;
}

async function askClaude(prompt: string, model: string): Promise<{ verdict: ReviewVerdict; inputTokens: number; outputTokens: number }> {
	const client = getClient();
	if (!client) throw new Error('ANTHROPIC_API_KEY not configured on the server');
	const res = await client.messages.create({
		model,
		max_tokens: 2500,
		system: SYSTEM_PROMPT,
		tools: [REVIEW_TOOL as any],
		tool_choice: { type: 'tool', name: 'report_review' },
		messages: [{ role: 'user', content: prompt }]
	});
	const call = res.content.find((b: any) => b.type === 'tool_use') as any;
	if (!call) throw new Error('model returned no report_review call');
	const v = call.input as ReviewVerdict;
	if (!v || !v.status || !Array.isArray(v.findings)) throw new Error('report_review payload malformed');
	return { verdict: v, inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 };
}

// ---------- persistence ----------

export function dayKeyOf(d: Date): string {
	return d.toISOString().slice(0, 10);
}

async function persist(args: {
	spu: MonitoredSpu;
	dayKey: string;
	from: Date;
	to: Date;
	verdict: ReviewVerdict;
	inputCounts: Record<string, number>;
	model: string;
	inputTokens: number;
	outputTokens: number;
	costUsd: number | null;
	durationMs: number;
}): Promise<string> {
	const now = new Date();
	const existing = (await DeviceFinding.findOne({ deviceId: args.spu.deviceId, kind: 'daily_review', dayKey: args.dayKey }).select('_id').lean()) as any;
	const reviewId = existing?._id ?? generateId();
	await DeviceFinding.updateOne(
		{ deviceId: args.spu.deviceId, kind: 'daily_review', dayKey: args.dayKey },
		{
			$set: {
				spuId: args.spu._id,
				udi: args.spu.udi,
				status: args.verdict.status,
				summary: args.verdict.summary,
				windowFrom: args.from,
				windowTo: args.to,
				inputCounts: args.inputCounts,
				model: args.model,
				inputTokens: args.inputTokens,
				outputTokens: args.outputTokens,
				costUsd: args.costUsd,
				durationMs: args.durationMs,
				severity: args.verdict.findings.some((f) => f.severity === 'error') ? 'error' : args.verdict.findings.some((f) => f.severity === 'warning') ? 'warning' : 'info'
			},
			$setOnInsert: { _id: reviewId, kind: 'daily_review', deviceId: args.spu.deviceId, dayKey: args.dayKey }
		},
		{ upsert: true }
	);
	// Re-running a day replaces that day's findings rather than stacking duplicates.
	await DeviceFinding.deleteMany({ reviewId, kind: 'review_finding' });
	if (args.verdict.findings.length) {
		await DeviceFinding.insertMany(
			args.verdict.findings.map((f) => ({
				_id: generateId(),
				deviceId: args.spu.deviceId,
				spuId: args.spu._id,
				udi: args.spu.udi,
				kind: 'review_finding',
				reviewId,
				dayKey: args.dayKey,
				severity: f.severity,
				category: f.category,
				title: f.title,
				detail: f.detail,
				recommendation: f.recommendation,
				confidence: f.confidence,
				evidence: (f.evidence ?? []).slice(0, 10).map((e) => ({ source: e.source, at: e.at ? new Date(e.at) : undefined, text: String(e.text).slice(0, 500) })),
				windowFrom: args.from,
				windowTo: args.to,
				model: args.model
			}))
		);
	}
	await Spu.updateOne(
		{ _id: args.spu._id },
		{ $set: { 'monitoring.lastReviewAt': now, 'monitoring.lastReviewStatus': args.verdict.status, 'monitoring.lastReviewId': reviewId } }
	);
	return reviewId;
}

// ---------- entry points ----------

export async function reviewDevice(
	spu: MonitoredSpu,
	opts: { from: Date; to: Date; model?: string; controls?: MonitoredSpu[]; dryRun?: boolean }
): Promise<ReviewResult> {
	const started = Date.now();
	const model = opts.model ?? DEFAULT_REVIEW_MODEL;
	const dayKey = dayKeyOf(opts.to);
	await connectDB();
	try {
		const tl = await buildDeviceTimeline(spu.deviceId, opts.from, opts.to);
		const { text: timelineText, kept, dropped } = timelineToText(tl.timeline);
		const recs = await loadRecords(spu.deviceId, opts.from, opts.to);
		const controls: { udi: string; recs: RecordSummary[] }[] = [];
		for (const c of (opts.controls ?? []).filter((c) => c.deviceId !== spu.deviceId).slice(0, 5)) {
			controls.push({ udi: c.udi, recs: await loadRecords(c.deviceId, opts.from, opts.to) });
		}
		const inputCounts = {
			logLines: tl.logs.reduce((n: number, l: any) => n + (l.lineCount ?? l.logLines?.length ?? 0), 0),
			logUploads: tl.logs.length,
			events: tl.events.length,
			webhooks: tl.webhookLogs.length,
			crashes: tl.crashes.length,
			records: recs.length,
			controls: controls.length
		};
		const prior = (await DeviceFinding.findOne({ deviceId: spu.deviceId, kind: 'daily_review', dayKey: { $lt: dayKey } }).sort({ dayKey: -1 }).select('summary status').lean()) as any;
		const prompt = buildPrompt({
			spu,
			from: opts.from,
			to: opts.to,
			timelineText,
			timelineKept: kept,
			timelineDropped: dropped,
			recordsText: recordsToText(recs),
			controlsText: controlsToText(controls),
			priorSummary: prior ? `${prior.status}: ${prior.summary}` : null
		});

		if (opts.dryRun) {
			return { spuId: spu._id, udi: spu.udi, deviceId: spu.deviceId, dayKey, status: 'no_data', summary: '(dry run)', findingCount: 0, inputCounts, model, durationMs: Date.now() - started, prompt };
		}

		const nothing = tl.timeline.length === 0 && recs.length === 0;
		let verdict: ReviewVerdict;
		let inputTokens = 0;
		let outputTokens = 0;
		if (nothing) {
			verdict = { status: 'no_data', summary: 'No log uploads, webhook traffic, crashes, events or test records in the window.', findings: [] };
		} else {
			const r = await askClaude(prompt, model);
			verdict = r.verdict;
			inputTokens = r.inputTokens;
			outputTokens = r.outputTokens;
		}
		const price = PRICING[model];
		const costUsd = price ? Number(((inputTokens * price.input + outputTokens * price.output) / 1e6).toFixed(4)) : null;
		const durationMs = Date.now() - started;
		const reviewId = await persist({ spu, dayKey, from: opts.from, to: opts.to, verdict, inputCounts, model: nothing ? 'none' : model, inputTokens, outputTokens, costUsd, durationMs });
		return { spuId: spu._id, udi: spu.udi, deviceId: spu.deviceId, dayKey, status: verdict.status, summary: verdict.summary, findingCount: verdict.findings.length, reviewId, inputCounts, model, costUsd, durationMs };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		try {
			await DeviceFinding.updateOne(
				{ deviceId: spu.deviceId, kind: 'daily_review', dayKey },
				{ $set: { spuId: spu._id, udi: spu.udi, status: 'error', summary: `Review failed: ${message}`, windowFrom: opts.from, windowTo: opts.to, model, durationMs: Date.now() - started }, $setOnInsert: { _id: generateId(), kind: 'daily_review', deviceId: spu.deviceId, dayKey } },
				{ upsert: true }
			);
		} catch {
			// best effort
		}
		return { spuId: spu._id, udi: spu.udi, deviceId: spu.deviceId, dayKey, status: 'error', summary: message, findingCount: 0, inputCounts: {}, model, durationMs: Date.now() - started, error: message };
	}
}

export async function runDailyReview(opts: { to?: Date; hours?: number; spuId?: string; model?: string; dryRun?: boolean } = {}): Promise<{ results: ReviewResult[]; monitored: number }> {
	const to = opts.to ?? new Date();
	const from = new Date(to.getTime() - (opts.hours ?? 24) * 3600 * 1000);
	const all = await listMonitoredSpus();
	const controls = all.filter((s) => s.role === 'control');
	const targets = all.filter((s) => s.role === 'suspect' && (!opts.spuId || s._id === opts.spuId));
	// A control with no suspects to compare against still gets reviewed on its own.
	const extraControls = opts.spuId ? controls.filter((c) => c._id === opts.spuId) : targets.length === 0 ? controls : [];
	const results: ReviewResult[] = [];
	for (const spu of [...targets, ...extraControls]) {
		results.push(await reviewDevice(spu, { from, to, model: opts.model, controls, dryRun: opts.dryRun }));
	}
	return { results, monitored: all.length };
}
