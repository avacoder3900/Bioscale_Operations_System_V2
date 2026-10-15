/**
 * Unified device timeline — one ordered list built from the four diagnostic
 * collections (device_logs, webhook_logs, device_crashes, device_events).
 * Used by the SPU diagnostics page and by the daily monitor review
 * (device-monitor-review.ts). Spec: docs/BIMS-UNIFIED-TIMELINE-SPEC.md.
 */
import { connectDB, DeviceLog, DeviceCrash, WebhookLog, DeviceEvent } from '$lib/server/db';

export interface TimelineEntry {
	timestamp: string;
	source: 'firmware' | 'webhook' | 'crash' | 'event';
	data: any;
}

export interface DeviceTimeline {
	timeline: TimelineEntry[]; // newest first
	logs: any[]; // ascending by uploadedAt
	crashes: any[];
	webhookLogs: any[];
	events: any[];
}

export async function buildDeviceTimeline(particleDeviceId: string, dateFrom: Date, dateTo: Date): Promise<DeviceTimeline> {
	await connectDB();

	const logFilter = { deviceId: particleDeviceId, uploadedAt: { $gte: dateFrom, $lte: dateTo } };
	const crashFilter = { deviceId: particleDeviceId, detectedAt: { $gte: dateFrom, $lte: dateTo } };
	const webhookFilter = { deviceId: particleDeviceId, timestamp: { $gte: dateFrom, $lte: dateTo } };
	const eventFilter = { deviceId: particleDeviceId, createdAt: { $gte: dateFrom, $lte: dateTo } };

	const [logs, crashes, webhookLogs, events] = await Promise.all([
		DeviceLog.find(logFilter).sort({ uploadedAt: 1 }).lean() as Promise<any[]>,
		DeviceCrash.find(crashFilter).sort({ detectedAt: 1 }).lean() as Promise<any[]>,
		WebhookLog.find(webhookFilter).sort({ timestamp: 1 }).lean() as Promise<any[]>,
		DeviceEvent.find(eventFilter).sort({ createdAt: 1 }).lean() as Promise<any[]>
	]);

	const timeline: TimelineEntry[] = [];

	// Group device_logs by bootCount to reconstruct continuous sessions.
	// Multiple upload chunks share the same bootCount — they're not separate reboots.
	// Only emit a session header when bootCount changes.
	let lastBootCount: number | null = null;

	for (const log of logs) {
		const uploadTime = new Date(log.uploadedAt).getTime();
		const maxMs = log.logLines?.length > 0 ? Math.max(...log.logLines.map((l: any) => l.ms ?? 0)) : 0;

		// Per-chunk anchor: the last line in this chunk was written at ~uploadedAt,
		// so the chunk's time origin is (uploadedAt - maxMs). Each line's wall-clock
		// is then (uploadedAt - maxMs + line.ms). This correctly interleaves firmware
		// lines with webhook/event timestamps that use server wall-clock time.
		const chunkOrigin = uploadTime - maxMs;

		if (log.bootCount !== lastBootCount) {
			const displayName = log.deviceName || log.deviceId;
			const fwLabel = log.firmwareVersion != null ? `v${log.firmwareVersion}` : 'unknown';
			const bootLabel = log.bootCount != null ? `#${log.bootCount}` : 'unknown';
			const minMs = log.logLines?.length > 0 ? Math.min(...log.logLines.map((l: any) => l.ms ?? 0)) : 0;

			timeline.push({
				timestamp: new Date(chunkOrigin + minMs).toISOString(),
				source: 'firmware',
				data: {
					ms: 0,
					message: `======== SESSION START ========\nBoot ${bootLabel} | ${displayName} | Firmware: ${fwLabel}`,
					sessionId: log.sessionId,
					isSessionHeader: true,
					firmwareVersion: log.firmwareVersion,
					bootCount: log.bootCount,
					deviceName: log.deviceName,
					uploadedAt: log.uploadedAt
				}
			});
			lastBootCount = log.bootCount;
		}

		if (log.logLines) {
			for (const line of log.logLines) {
				timeline.push({
					timestamp: new Date(chunkOrigin + (line.ms || 0)).toISOString(),
					source: 'firmware',
					data: { ms: line.ms, message: line.message, sessionId: log.sessionId, firmwareVersion: log.firmwareVersion }
				});
			}
		}
	}

	for (const wh of webhookLogs) {
		timeline.push({
			timestamp: new Date(wh.timestamp).toISOString(),
			source: 'webhook',
			data: {
				eventName: wh.eventName,
				status: wh.response?.status ?? null,
				processingTimeMs: wh.processingTimeMs ?? null,
				errorMessage: wh.response?.errorMessage ?? null,
				request: wh.request ?? null,
				response: wh.response ?? null,
				_id: wh._id
			}
		});
	}

	for (const cr of crashes) {
		timeline.push({
			timestamp: new Date(cr.detectedAt).toISOString(),
			source: 'crash',
			data: {
				lastCheckpoint: cr.lastCheckpoint,
				lastCheckpointName: cr.lastCheckpointName,
				crashCategory: cr.crashCategory,
				checkpointSequence: cr.checkpointSequence ?? [],
				firmwareVersion: cr.firmwareVersion,
				bootCount: cr.bootCount,
				sessionLogId: cr.sessionLogId,
				_id: cr._id
			}
		});
	}

	for (const ev of events) {
		timeline.push({
			timestamp: new Date(ev.createdAt).toISOString(),
			source: 'event',
			data: { eventType: ev.eventType, eventData: ev.eventData, success: ev.success, errorMessage: ev.errorMessage, _id: ev._id }
		});
	}

	timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

	return { timeline, logs, crashes, webhookLogs, events };
}

const ERROR_RE = /ERROR|WARN|OVERHEAT|INTERRUPTED|THERMISTOR DISCONNECT|failed|timeout|not found|SWITCH NOT FOUND|rejected|Invalid/i;
const KEEP_RE = /^---- (MONITOR|END MONITOR)|^(fw v|mode |last_error|cloud |heater |stage |T\d+ )|^State transition|^Stage check|^Test |^Sonic run|^Cached test|^All cached|^Upload|^Monitor flag|^Service flag|^=== |^!!! |^\s*CP\[|^Boot #|^Firmware:|^Cloud connection|^Heater|^Screen|^Device error|^Magnet|^Session log|^Webhook response|^Validat|^Cartridge/i;
const REDACT_RE = /password|ssid|credential|token/i;

/**
 * Flatten a timeline into the compact text the review model reads. Keeps every
 * non-firmware entry, every firmware line that explains something (errors,
 * transitions, stage checks, MONITOR blocks, session headers) and, within the
 * budget, routine lines too. Oldest-first. Never includes credential lines.
 */
export function timelineToText(entries: TimelineEntry[], opts: { maxChars?: number } = {}): { text: string; kept: number; dropped: number } {
	const maxChars = opts.maxChars ?? 40_000;
	const asc = [...entries].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

	type Line = { t: string; text: string; important: boolean };
	const lines: Line[] = [];
	for (const e of asc) {
		const t = e.timestamp.slice(5, 19).replace('T', ' '); // MM-DD HH:MM:SS
		if (e.source === 'firmware') {
			const msg: string = e.data.isSessionHeader ? e.data.message.replace('\n', ' ') : (e.data.message ?? '');
			if (REDACT_RE.test(msg)) continue;
			const important = e.data.isSessionHeader || ERROR_RE.test(msg) || KEEP_RE.test(msg);
			lines.push({ t, text: `${t} fw  ${msg}`, important });
		} else if (e.source === 'webhook') {
			const d = e.data;
			lines.push({ t, text: `${t} hook ${d.eventName} ${d.status ?? '?'}${d.processingTimeMs != null ? ` ${d.processingTimeMs}ms` : ''}${d.errorMessage ? ` err="${String(d.errorMessage).slice(0, 120)}"` : ''}`, important: true });
		} else if (e.source === 'crash') {
			const d = e.data;
			lines.push({ t, text: `${t} CRASH boot#${d.bootCount} at CP${d.lastCheckpoint} ${d.lastCheckpointName} (${d.crashCategory}) seq=[${(d.checkpointSequence ?? []).join(',')}]`, important: true });
		} else {
			const d = e.data;
			const payload = typeof d.eventData === 'string' ? d.eventData : JSON.stringify(d.eventData ?? null);
			lines.push({ t, text: `${t} ev  ${d.eventType}${d.success === false ? ' FAILED' : ''} ${String(payload ?? '').slice(0, 160)}`, important: d.success === false || /error|fail|crash|screen|stage/i.test(d.eventType ?? '') });
		}
	}

	// Budget: important lines first, then routine lines newest-first until full.
	let total = 0;
	const chosen = new Set<number>();
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].important && total + lines[i].text.length + 1 <= maxChars) {
			chosen.add(i);
			total += lines[i].text.length + 1;
		}
	}
	for (let i = lines.length - 1; i >= 0; i--) {
		if (chosen.has(i)) continue;
		if (total + lines[i].text.length + 1 > maxChars) continue;
		chosen.add(i);
		total += lines[i].text.length + 1;
	}
	const out: string[] = [];
	let lastKept = -1;
	for (let i = 0; i < lines.length; i++) {
		if (!chosen.has(i)) continue;
		if (lastKept >= 0 && i - lastKept > 1) out.push(`   ... ${i - lastKept - 1} routine line(s) omitted ...`);
		out.push(lines[i].text);
		lastKept = i;
	}
	return { text: out.join('\n'), kept: chosen.size, dropped: lines.length - chosen.size };
}
