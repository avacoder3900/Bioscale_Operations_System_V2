/**
 * Reactive store backed by SSE from /api/opentrons-lab/robots/health-stream.
 * Auto-reconnects on disconnect.
 */
import { writable } from 'svelte/store';

export interface RobotHealth {
	robotId: string;
	name: string;
	ip: string;
	port: number;
	isOnline: boolean;
	apiVersion: string | null;
	firmwareVersion: string | null;
	currentRunId: string | null;
	currentRunStatus: string | null;
	lastCheckedAt: string;
	responseTimeMs: number | null;
	errorMessage: string | null;
}

export const robotHealthStates = writable<RobotHealth[]>([]);
export const sseConnected = writable(false);

let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function connectHealthSSE() {
	if (eventSource) return;
	eventSource = new EventSource('/api/opentrons-lab/robots/health-stream');

	eventSource.onopen = () => sseConnected.set(true);

	eventSource.onmessage = (event) => {
		try {
			const states: RobotHealth[] = JSON.parse(event.data);
			robotHealthStates.set(states);
		} catch { /* ignore parse errors */ }
	};

	eventSource.onerror = () => {
		sseConnected.set(false);
		eventSource?.close();
		eventSource = null;
		reconnectTimer = setTimeout(connectHealthSSE, 5000);
	};
}

export function disconnectHealthSSE() {
	if (reconnectTimer) clearTimeout(reconnectTimer);
	eventSource?.close();
	eventSource = null;
	sseConnected.set(false);
}
