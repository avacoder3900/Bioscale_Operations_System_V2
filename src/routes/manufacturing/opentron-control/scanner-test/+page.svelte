<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { invalidateAll, goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	type ScannerEvent = {
		_id: string;
		deviceId: string;
		eventType: 'scan' | 'heartbeat' | 'error' | 'trigger_consumed';
		barcode?: string;
		rawPayload?: string;
		source?: string;
		contextRef?: string;
		errorMessage?: string;
		metadata?: Record<string, unknown>;
		receivedAt: string;
	};

	let events = $state<ScannerEvent[]>(data.events ?? []);
	let lastHeartbeat = $state<ScannerEvent | null>(data.lastHeartbeat ?? null);
	let pendingTriggers = $state<number>(data.pendingTriggers ?? 0);
	let serverTime = $state<string>(data.serverTime);
	let now = $state<number>(Date.now());

	// Selected device — driven by ?deviceId= query param, with fallback.
	let deviceId = $state<string>(data.deviceId);
	let deviceInput = $state<string>(data.deviceId);

	let triggering = $state(false);
	let triggerError = $state<string | null>(null);
	let pollErrorCount = $state(0);

	const HEARTBEAT_OFFLINE_MS = 30_000; // 30s without heartbeat → offline

	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let clockTimer: ReturnType<typeof setInterval> | null = null;

	$effect(() => {
		// React to ?deviceId= changes from address bar / device picker.
		if (data.deviceId !== deviceId) {
			deviceId = data.deviceId;
			deviceInput = data.deviceId;
			events = data.events ?? [];
			lastHeartbeat = data.lastHeartbeat ?? null;
			pendingTriggers = data.pendingTriggers ?? 0;
			serverTime = data.serverTime;
		}
	});

	async function poll() {
		try {
			const sinceParam = events[0]?.receivedAt;
			const url = new URL('/api/scanner/events', window.location.origin);
			url.searchParams.set('deviceId', deviceId);
			url.searchParams.set('limit', '50');
			if (sinceParam) url.searchParams.set('since', sinceParam);

			const res = await fetch(url, { credentials: 'same-origin' });
			if (!res.ok) {
				pollErrorCount++;
				return;
			}
			pollErrorCount = 0;

			const body = await res.json();
			serverTime = body.serverTime;
			if (body.lastHeartbeat) lastHeartbeat = body.lastHeartbeat;

			if (Array.isArray(body.events) && body.events.length > 0) {
				const incoming = body.events as ScannerEvent[];
				const existingIds = new Set(events.map((e) => e._id));
				const fresh = incoming.filter((e) => !existingIds.has(e._id));
				if (fresh.length > 0) {
					events = [...fresh, ...events].slice(0, 50);
				}
			}
		} catch (err) {
			pollErrorCount++;
		}
	}

	async function fireTrigger() {
		triggerError = null;
		triggering = true;
		try {
			const res = await fetch('/api/scanner/trigger', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ deviceId, source: 'test' })
			});
			if (!res.ok) {
				const errText = await res.text();
				triggerError = errText || `Failed: ${res.status}`;
			} else {
				pendingTriggers++;
				// Poll quickly so the user sees the new event land
				setTimeout(poll, 600);
				setTimeout(poll, 1500);
			}
		} catch (err) {
			triggerError = err instanceof Error ? err.message : String(err);
		} finally {
			triggering = false;
		}
	}

	function applyDevice() {
		const val = deviceInput.trim() || data.defaultDeviceId;
		const url = new URL($page.url);
		url.searchParams.set('deviceId', val);
		goto(url.toString(), { replaceState: false, keepFocus: true });
	}

	function isOnline(): boolean {
		if (!lastHeartbeat) return false;
		const last = new Date(lastHeartbeat.receivedAt).getTime();
		return now - last < HEARTBEAT_OFFLINE_MS;
	}

	function secondsSinceHeartbeat(): number | null {
		if (!lastHeartbeat) return null;
		return Math.floor((now - new Date(lastHeartbeat.receivedAt).getTime()) / 1000);
	}

	function formatTime(iso: string): string {
		const d = new Date(iso);
		return d.toLocaleTimeString('en-US', {
			hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
		});
	}

	function formatRelative(iso: string): string {
		const ms = now - new Date(iso).getTime();
		const s = Math.max(0, Math.floor(ms / 1000));
		if (s < 60) return `${s}s ago`;
		if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
		return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
	}

	function eventTypeColor(t: string): string {
		if (t === 'scan') return 'border-green-500/40 bg-green-900/15';
		if (t === 'error') return 'border-red-500/50 bg-red-900/15';
		if (t === 'trigger_consumed') return 'border-yellow-500/30 bg-yellow-900/10';
		return 'border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]';
	}

	const lastScan = $derived(events.find((e) => e.eventType === 'scan') ?? null);
	const scanCount = $derived(events.filter((e) => e.eventType === 'scan').length);
	const errorCount = $derived(events.filter((e) => e.eventType === 'error').length);

	onMount(() => {
		pollTimer = setInterval(poll, 1000);
		clockTimer = setInterval(() => { now = Date.now(); }, 1000);
	});

	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
		if (clockTimer) clearInterval(clockTimer);
	});
</script>

<div class="mx-auto max-w-6xl space-y-6 p-4">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Barcode Scanner Test</h1>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
				Validate the Waveshare scanner and bridge daemon round-trip. Fire triggers from
				here, watch decoded payloads land in the event stream.
			</p>
		</div>
		<a href="/manufacturing/opentron-control"
			class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs hover:border-[var(--color-tron-cyan)] transition-colors"
			style="color: var(--color-tron-text)">
			← Back to Opentron Control
		</a>
	</div>

	<!-- Device selector + bridge status -->
	<section class="grid grid-cols-1 gap-4 md:grid-cols-2">
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<h3 class="mb-3 text-xs font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
				Device
			</h3>
			<div class="flex gap-2">
				<input
					type="text"
					bind:value={deviceInput}
					placeholder={data.defaultDeviceId}
					class="flex-1 rounded border border-[var(--color-tron-border)] bg-black/30 px-3 py-2 font-mono text-sm"
					style="color: var(--color-tron-text)"
					onkeydown={(e) => { if (e.key === 'Enter') applyDevice(); }}
				/>
				<button
					type="button"
					onclick={applyDevice}
					class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-2 text-xs font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20 transition-colors"
				>
					Switch
				</button>
			</div>
			{#if data.knownDevices.length > 1}
				<div class="mt-2 flex flex-wrap gap-1">
					{#each data.knownDevices as d}
						<button
							type="button"
							onclick={() => { deviceInput = d; applyDevice(); }}
							class="rounded px-2 py-0.5 font-mono text-[10px] {d === deviceId ? 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]' : 'border border-[var(--color-tron-border)]'}"
							style="color: {d === deviceId ? 'var(--color-tron-cyan)' : 'var(--color-tron-text-secondary)'}"
						>
							{d}
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<div class="rounded-lg border p-4 {isOnline() ? 'border-green-500/40 bg-green-900/10' : 'border-red-500/40 bg-red-900/10'}">
			<h3 class="mb-2 text-xs font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
				Bridge Daemon
			</h3>
			<div class="flex items-center justify-between">
				<div>
					<div class="text-lg font-semibold {isOnline() ? 'text-green-300' : 'text-red-300'}">
						{isOnline() ? 'Online' : 'Offline'}
					</div>
					{#if lastHeartbeat}
						<div class="text-xs" style="color: var(--color-tron-text-secondary)">
							Last heartbeat: {secondsSinceHeartbeat()}s ago
						</div>
					{:else}
						<div class="text-xs" style="color: var(--color-tron-text-secondary)">
							No heartbeats received yet
						</div>
					{/if}
				</div>
				<div class="text-right text-xs" style="color: var(--color-tron-text-secondary)">
					{#if pendingTriggers > 0}
						<div class="font-bold text-yellow-300">{pendingTriggers} trigger(s) pending</div>
					{/if}
					{#if pollErrorCount > 2}
						<div class="text-red-400">Poll errors: {pollErrorCount}</div>
					{/if}
				</div>
			</div>
		</div>
	</section>

	<!-- Trigger + last scan -->
	<section class="grid grid-cols-1 gap-4 lg:grid-cols-3">
		<div class="rounded-lg border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/5 p-5">
			<h3 class="mb-3 text-xs font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
				Manual Trigger
			</h3>
			<button
				type="button"
				onclick={fireTrigger}
				disabled={triggering}
				class="w-full rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 px-4 py-3 text-sm font-bold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/25 disabled:opacity-40 transition-colors"
			>
				{triggering ? 'Sending…' : 'Trigger Scan'}
			</button>
			{#if triggerError}
				<p class="mt-2 text-xs text-red-400">{triggerError}</p>
			{/if}
			<p class="mt-3 text-[11px]" style="color: var(--color-tron-text-secondary)">
				Enqueues a trigger for <span class="font-mono">{deviceId}</span>. The bridge
				daemon picks it up on its next poll (~500ms) and fires the scanner.
			</p>
		</div>

		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-5 lg:col-span-2">
			<h3 class="mb-3 text-xs font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
				Last Scan
			</h3>
			{#if lastScan}
				<div class="space-y-2">
					<div class="break-all rounded bg-black/40 p-3 font-mono text-xl" style="color: var(--color-tron-cyan)">
						{lastScan.barcode || '(empty payload)'}
					</div>
					<div class="flex justify-between text-xs" style="color: var(--color-tron-text-secondary)">
						<span>{formatRelative(lastScan.receivedAt)}</span>
						<span class="font-mono">{formatTime(lastScan.receivedAt)}</span>
					</div>
				</div>
			{:else}
				<div class="rounded bg-black/20 p-6 text-center text-sm" style="color: var(--color-tron-text-secondary)">
					No scans yet. Hit "Trigger Scan" or wait for the daemon to deliver one.
				</div>
			{/if}
		</div>
	</section>

	<!-- Stats -->
	<section class="grid grid-cols-3 gap-3">
		<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 text-center">
			<div class="text-2xl font-bold text-green-300">{scanCount}</div>
			<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Scans (last 50)</div>
		</div>
		<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 text-center">
			<div class="text-2xl font-bold text-red-300">{errorCount}</div>
			<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Errors</div>
		</div>
		<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 text-center">
			<div class="text-2xl font-bold" style="color: var(--color-tron-cyan)">{pendingTriggers}</div>
			<div class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Pending Triggers</div>
		</div>
	</section>

	<!-- Event stream -->
	<section>
		<div class="mb-2 flex items-center justify-between">
			<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
				Event Stream
			</h2>
			<form method="POST" action="?/clear" use:enhance={() => {
				return async ({ result, update }) => {
					if (result.type === 'success') {
						events = [];
						pendingTriggers = 0;
						await update({ reset: false });
						invalidateAll();
					}
				};
			}}>
				<input type="hidden" name="deviceId" value={deviceId} />
				<button
					type="submit"
					onclick={(e) => { if (!confirm(`Delete all ${deviceId} events and triggers?`)) e.preventDefault(); }}
					class="rounded border border-red-500/40 px-3 py-1 text-xs text-red-300 hover:bg-red-900/20 transition-colors"
				>
					Clear history
				</button>
			</form>
		</div>

		{#if form?.success}
			<div class="mb-2 rounded border border-green-500/30 bg-green-900/15 p-2 text-xs text-green-300">
				Cleared {form.cleared.events} events, {form.cleared.triggers} triggers.
			</div>
		{/if}

		{#if events.length === 0}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-6 text-center">
				<p class="text-sm" style="color: var(--color-tron-text-secondary)">No events yet for this device.</p>
			</div>
		{:else}
			<div class="space-y-1.5">
				{#each events as ev (ev._id)}
					<div class="rounded border p-2.5 {eventTypeColor(ev.eventType)}">
						<div class="flex items-start justify-between gap-3">
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<span class="rounded bg-black/30 px-1.5 py-0.5 text-[10px] font-bold uppercase" style="color: var(--color-tron-text)">
										{ev.eventType}
									</span>
									{#if ev.source && ev.source !== 'unknown'}
										<span class="text-[10px]" style="color: var(--color-tron-text-secondary)">{ev.source}</span>
									{/if}
									{#if ev.contextRef}
										<span class="font-mono text-[10px]" style="color: var(--color-tron-text-secondary)">→ {ev.contextRef}</span>
									{/if}
								</div>
								{#if ev.eventType === 'scan' && ev.barcode}
									<div class="mt-1 break-all font-mono text-sm" style="color: var(--color-tron-cyan)">
										{ev.barcode}
									</div>
								{:else if ev.eventType === 'error' && ev.errorMessage}
									<div class="mt-1 break-all text-sm text-red-300">
										{ev.errorMessage}
									</div>
								{:else if ev.eventType === 'heartbeat' && ev.metadata}
									<div class="mt-1 font-mono text-[11px]" style="color: var(--color-tron-text-secondary)">
										{JSON.stringify(ev.metadata)}
									</div>
								{/if}
							</div>
							<div class="text-right text-[11px]" style="color: var(--color-tron-text-secondary)">
								<div class="font-mono">{formatTime(ev.receivedAt)}</div>
								<div>{formatRelative(ev.receivedAt)}</div>
							</div>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</section>

	<!-- Setup help -->
	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)]/50 p-4">
		<h3 class="mb-2 text-xs font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
			Bridge daemon setup
		</h3>
		<ol class="ml-4 list-decimal space-y-1 text-xs" style="color: var(--color-tron-text-secondary)">
			<li>On the Lab Mac, plug the Waveshare scanner into USB. Confirm it appears as <span class="font-mono">/dev/tty.usbmodem*</span>.</li>
			<li>Configure the scanner for USB-CDC + command-trigger mode (scan setting QRs from the Waveshare manual once on the bench).</li>
			<li>Set env vars: <span class="font-mono">SCANNER_DEVICE_ID</span>, <span class="font-mono">SCANNER_SERIAL_PORT</span>, <span class="font-mono">BIMS_BASE_URL</span>, <span class="font-mono">BIMS_AGENT_API_KEY</span>.</li>
			<li>Run <span class="font-mono">python3 scripts/scanner-bridge.py</span>. Heartbeats should arrive within 10s; this card will go green.</li>
			<li>Click "Trigger Scan" above. A scan event should land in the stream within ~1s.</li>
		</ol>
	</section>
</div>
