<script lang="ts">
	/**
	 * ThermocoupleCapture - Autonomous temperature data capture component
	 *
	 * This component:
	 * 1. Receives session config (duration, interval, temp range)
	 * 2. Connects to thermocouple via Web Serial API
	 * 3. Autonomously captures readings at specified interval
	 * 4. Shows real-time temperature and progress
	 * 5. Auto-stops when duration complete
	 * 6. Emits collected data when done
	 */

	import { onDestroy } from 'svelte';

	// Thermocouple reading interface
	export interface ThermocoupleReading {
		timestamp: number;
		temperature: number;
		unit: 'C' | 'F';
	}

	// Configuration passed from parent
	export interface ThermocoupleConfig {
		durationSeconds: number;
		intervalSeconds: number;
		minTemp: number;
		maxTemp: number;
	}

	interface Props {
		sessionId: string;
		config: ThermocoupleConfig;
		onComplete?: (readings: ThermocoupleReading[]) => void;
		onError?: (error: Error) => void;
	}

	let { sessionId, config, onComplete, onError }: Props = $props();

	// Connection state
	type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';
	let connectionState = $state<ConnectionState>('disconnected');
	let connectionError = $state<string | null>(null);

	// Serial port reference
	let port: SerialPort | null = $state(null);
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = $state(null);

	// Capture state
	type CaptureState = 'idle' | 'ready' | 'capturing' | 'completed' | 'error';
	let captureState = $state<CaptureState>('idle');
	let capturedReadings = $state<ThermocoupleReading[]>([]);
	let currentReading = $state<ThermocoupleReading | null>(null);

	// Timer state
	let startTime = $state<number | null>(null);
	let elapsedSeconds = $state(0);
	let timerInterval: ReturnType<typeof setInterval> | null = null;
	let captureInterval: ReturnType<typeof setInterval> | null = null;

	// Computed values
	let isConnected = $derived(connectionState === 'connected');
	let isCapturing = $derived(captureState === 'capturing');
	let isCompleted = $derived(captureState === 'completed');
	let progress = $derived(Math.min((elapsedSeconds / config.durationSeconds) * 100, 100));
	let timeRemaining = $derived(Math.max(config.durationSeconds - elapsedSeconds, 0));
	let expectedReadings = $derived(Math.ceil(config.durationSeconds / config.intervalSeconds));

	// Temperature status
	let tempStatus = $derived.by(() => {
		if (!currentReading) return 'unknown';
		if (currentReading.temperature < config.minTemp) return 'below';
		if (currentReading.temperature > config.maxTemp) return 'above';
		return 'in-range';
	});

	// Check Web Serial support
	let isSupported = $derived(typeof navigator !== 'undefined' && 'serial' in navigator);

	// Format helpers
	function formatTime(seconds: number): string {
		const mins = Math.floor(seconds / 60);
		const secs = Math.floor(seconds % 60);
		return mins > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : `${secs}s`;
	}

	function formatTemp(temp: number): string {
		return temp.toFixed(1);
	}

	// Connect to thermocouple via Web Serial
	async function connect() {
		if (!isSupported) {
			connectionError = 'Web Serial API not supported in this browser';
			connectionState = 'error';
			return;
		}

		connectionState = 'connecting';
		connectionError = null;

		try {
			// Request serial port from user
			port = await navigator.serial!.requestPort();

			// Open with typical thermocouple baud rate
			await port.open({ baudRate: 9600 });

			connectionState = 'connected';
			captureState = 'ready';
		} catch (err) {
			connectionState = 'error';
			connectionError = err instanceof Error ? err.message : 'Failed to connect';
			onError?.(err instanceof Error ? err : new Error('Connection failed'));
		}
	}

	// Disconnect from thermocouple
	async function disconnect() {
		stopCapture();

		try {
			if (reader) {
				await reader.cancel();
				reader.releaseLock();
				reader = null;
			}
			if (port) {
				await port.close();
				port = null;
			}
		} catch (err) {
			console.warn('Error during disconnect:', err);
		}

		connectionState = 'disconnected';
		captureState = 'idle';
	}

	// Parse temperature data from serial line
	function parseTemperature(line: string): number | null {
		// Support multiple formats:
		// - "25.5" - just temperature
		// - "T:25.5" or "T=25.5" - prefixed
		// - "25.5,C" or "25.5 C" - with unit
		// - JSON: {"temperature": 25.5}

		const trimmed = line.trim();

		// Try JSON
		if (trimmed.startsWith('{')) {
			try {
				const data = JSON.parse(trimmed);
				return Number(data.temperature ?? data.temp ?? data.T ?? data.t);
			} catch {
				// Not JSON
			}
		}

		// Try prefixed format
		const prefixMatch = trimmed.match(/[Tt][=:]\s*([-\d.]+)/);
		if (prefixMatch) {
			return Number(prefixMatch[1]);
		}

		// Try plain number
		const numMatch = trimmed.match(/^([-\d.]+)/);
		if (numMatch) {
			const val = Number(numMatch[1]);
			// Sanity check - reasonable temperature range
			if (!isNaN(val) && val > -50 && val < 200) {
				return val;
			}
		}

		return null;
	}

	// Read data from serial port
	async function readSerial() {
		if (!port?.readable) return;

		reader = port.readable.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (captureState === 'capturing') {
				const { value, done } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				// Process complete lines
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					const temp = parseTemperature(line);
					if (temp !== null) {
						const reading: ThermocoupleReading = {
							timestamp: Date.now(),
							temperature: temp,
							unit: 'C'
						};
						currentReading = reading;
					}
				}
			}
		} catch (err) {
			if (captureState === 'capturing') {
				connectionError = err instanceof Error ? err.message : 'Read error';
				captureState = 'error';
				onError?.(err instanceof Error ? err : new Error('Read error'));
			}
		} finally {
			reader?.releaseLock();
			reader = null;
		}
	}

	// Start autonomous capture
	function startCapture() {
		if (!isConnected || captureState !== 'ready') return;

		capturedReadings = [];
		elapsedSeconds = 0;
		startTime = Date.now();
		captureState = 'capturing';

		// Start reading serial data
		readSerial();

		// Timer to track elapsed time
		timerInterval = setInterval(() => {
			if (startTime) {
				elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);

				// Check if capture complete
				if (elapsedSeconds >= config.durationSeconds) {
					completeCapture();
				}
			}
		}, 100);

		// Interval to capture readings at specified rate
		captureInterval = setInterval(() => {
			if (currentReading && captureState === 'capturing') {
				capturedReadings = [...capturedReadings, { ...currentReading }];
			}
		}, config.intervalSeconds * 1000);

		// Capture first reading immediately
		if (currentReading) {
			capturedReadings = [{ ...currentReading }];
		}
	}

	// Complete capture (auto-called when duration reached)
	function completeCapture() {
		stopCapture();
		captureState = 'completed';
		onComplete?.(capturedReadings);
	}

	// Stop capture (can be called manually)
	function stopCapture() {
		if (timerInterval) {
			clearInterval(timerInterval);
			timerInterval = null;
		}
		if (captureInterval) {
			clearInterval(captureInterval);
			captureInterval = null;
		}
	}

	// Reset to allow new capture
	function resetCapture() {
		capturedReadings = [];
		elapsedSeconds = 0;
		startTime = null;
		currentReading = null;
		captureState = isConnected ? 'ready' : 'idle';
	}

	// Cleanup on destroy
	onDestroy(() => {
		stopCapture();
		disconnect();
	});
</script>

<div class="space-y-6">
	<!-- Browser Support Warning -->
	{#if !isSupported}
		<div class="flex items-start gap-3 rounded-lg bg-[var(--color-tron-red)]/10 p-4">
			<svg
				class="h-5 w-5 flex-shrink-0 text-[var(--color-tron-red)]"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
				/>
			</svg>
			<div>
				<p class="tron-heading font-medium">Browser Not Supported</p>
				<p class="tron-text-muted mt-1 text-sm">
					Web Serial API is required. Please use Chrome, Edge, or another Chromium-based browser.
				</p>
			</div>
		</div>
	{:else}
		<!-- Config Display -->
		<div class="tron-card p-4">
			<h3 class="tron-text-muted mb-2 text-sm font-medium uppercase">Test Configuration</h3>
			<div class="grid grid-cols-2 gap-4 md:grid-cols-4">
				<div>
					<span class="tron-text-muted block text-xs">Duration</span>
					<span class="tron-heading font-medium">{formatTime(config.durationSeconds)}</span>
				</div>
				<div>
					<span class="tron-text-muted block text-xs">Interval</span>
					<span class="tron-heading font-medium">{config.intervalSeconds}s</span>
				</div>
				<div>
					<span class="tron-text-muted block text-xs">Min Temp</span>
					<span class="tron-heading font-medium">{config.minTemp}°C</span>
				</div>
				<div>
					<span class="tron-text-muted block text-xs">Max Temp</span>
					<span class="tron-heading font-medium">{config.maxTemp}°C</span>
				</div>
			</div>
		</div>

		<!-- Connection Controls -->
		<div class="tron-card p-4">
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-3">
					<div
						class="h-3 w-3 rounded-full transition-all duration-300
						{isConnected
							? 'bg-[var(--color-tron-green)] shadow-[0_0_8px_var(--color-tron-green)]'
							: connectionState === 'connecting'
								? 'animate-pulse bg-[var(--color-tron-orange)]'
								: 'bg-[var(--color-tron-text-secondary)]'}"
					></div>
					<span class="tron-heading">
						{#if connectionState === 'connecting'}
							Connecting...
						{:else if isConnected}
							Thermocouple Connected
						{:else if connectionState === 'error'}
							Connection Error
						{:else}
							Not Connected
						{/if}
					</span>
				</div>

				{#if isConnected && !isCapturing}
					<button onclick={disconnect} class="tron-btn-secondary px-4 py-2 text-sm">
						Disconnect
					</button>
				{:else if !isConnected && !isCapturing}
					<button
						onclick={connect}
						disabled={connectionState === 'connecting'}
						class="tron-btn-primary flex items-center gap-2 px-4 py-2 text-sm disabled:opacity-50"
					>
						{#if connectionState === 'connecting'}
							<svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
								<circle
									class="opacity-25"
									cx="12"
									cy="12"
									r="10"
									stroke="currentColor"
									stroke-width="4"
								></circle>
								<path
									class="opacity-75"
									fill="currentColor"
									d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
								></path>
							</svg>
						{/if}
						Connect Thermocouple
					</button>
				{/if}
			</div>

			{#if connectionError}
				<p class="mt-2 text-sm text-[var(--color-tron-red)]">{connectionError}</p>
			{/if}
		</div>

		<!-- Main Capture Display -->
		{#if isConnected || isCompleted}
			<div class="tron-card overflow-hidden">
				<!-- Progress Header -->
				{#if isCapturing || isCompleted}
					<div class="relative h-2 bg-[var(--color-tron-bg-tertiary)]">
						<div
							class="absolute top-0 left-0 h-full transition-all duration-300
							{isCompleted ? 'bg-[var(--color-tron-green)]' : 'bg-[var(--color-tron-orange)]'}"
							style="width: {progress}%"
						></div>
					</div>
				{/if}

				<div class="p-6">
					<!-- Temperature Display -->
					<div class="mb-6 text-center">
						{#if currentReading}
							<div
								class="inline-flex items-baseline gap-2 rounded-lg px-8 py-4
								{tempStatus === 'in-range' ? 'bg-[var(--color-tron-green)]/10' : 'bg-[var(--color-tron-red)]/10'}"
							>
								<span
									class="text-6xl font-bold tabular-nums
									{tempStatus === 'in-range' ? 'text-[var(--color-tron-green)]' : 'text-[var(--color-tron-red)]'}"
								>
									{formatTemp(currentReading.temperature)}
								</span>
								<span class="tron-text-muted text-2xl">°C</span>
							</div>
							<p class="tron-text-muted mt-2 text-sm">
								{#if tempStatus === 'in-range'}
									Within acceptable range ({config.minTemp}°C - {config.maxTemp}°C)
								{:else if tempStatus === 'below'}
									Below minimum ({config.minTemp}°C)
								{:else}
									Above maximum ({config.maxTemp}°C)
								{/if}
							</p>
						{:else if !isCompleted}
							<div class="py-8">
								<svg
									class="mx-auto h-16 w-16 animate-pulse text-[var(--color-tron-text-secondary)]"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
									/>
								</svg>
								<p class="tron-text-muted mt-4">Waiting for temperature data...</p>
							</div>
						{/if}
					</div>

					<!-- Status Stats -->
					<div class="grid grid-cols-3 gap-4 text-center">
						<div>
							<span class="tron-text-muted block text-xs uppercase">Time Remaining</span>
							<span class="tron-heading text-xl font-bold">
								{#if isCompleted}
									Done
								{:else if isCapturing}
									{formatTime(timeRemaining)}
								{:else}
									{formatTime(config.durationSeconds)}
								{/if}
							</span>
						</div>
						<div>
							<span class="tron-text-muted block text-xs uppercase">Readings</span>
							<span class="tron-heading text-xl font-bold">
								{capturedReadings.length} / {expectedReadings}
							</span>
						</div>
						<div>
							<span class="tron-text-muted block text-xs uppercase">Status</span>
							<span
								class="text-xl font-bold
								{isCompleted
									? 'text-[var(--color-tron-green)]'
									: isCapturing
										? 'text-[var(--color-tron-orange)]'
										: 'text-[var(--color-tron-text-secondary)]'}"
							>
								{#if isCompleted}
									Complete
								{:else if isCapturing}
									Capturing
								{:else}
									Ready
								{/if}
							</span>
						</div>
					</div>

					<!-- Action Button -->
					<div class="mt-6 flex justify-center">
						{#if captureState === 'ready'}
							<button
								onclick={startCapture}
								class="flex items-center gap-3 rounded-lg bg-[var(--color-tron-orange)] px-8 py-4 text-lg font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-orange)]/90"
							>
								<svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
									/>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
									/>
								</svg>
								Start Autonomous Capture
							</button>
						{:else if isCapturing}
							<div
								class="flex items-center gap-3 rounded-lg bg-[var(--color-tron-orange)]/20 px-6 py-3"
							>
								<div class="h-3 w-3 animate-pulse rounded-full bg-[var(--color-tron-orange)]"></div>
								<span class="tron-heading font-medium">Capturing data...</span>
							</div>
						{:else if isCompleted}
							<a
								href="/spu/validation/thermocouple/{sessionId}"
								class="tron-button px-6 py-3"
								style="min-height: 44px; background: var(--color-tron-cyan); color: #000; font-weight: 600"
							>
								View Results
							</a>
							<button onclick={resetCapture} class="tron-btn-secondary px-6 py-3">
								Reset & Capture Again
							</button>
						{/if}
					</div>
				</div>
			</div>
		{/if}

		<!-- Captured Data Preview -->
		{#if capturedReadings.length > 0}
			<div class="tron-card">
				<div class="border-b border-[var(--color-tron-border)] p-4">
					<h3 class="tron-heading font-semibold">
						Captured Readings ({capturedReadings.length})
					</h3>
				</div>

				<div class="max-h-48 overflow-y-auto">
					<table class="w-full text-sm">
						<thead class="sticky top-0 bg-[var(--color-tron-bg-secondary)]">
							<tr class="text-left">
								<th class="tron-text-muted p-2">#</th>
								<th class="tron-text-muted p-2">Time</th>
								<th class="tron-text-muted p-2">Temperature</th>
								<th class="tron-text-muted p-2">Status</th>
							</tr>
						</thead>
						<tbody>
							{#each capturedReadings.slice(-15) as reading, i (reading.timestamp)}
								{@const inRange =
									reading.temperature >= config.minTemp && reading.temperature <= config.maxTemp}
								<tr class="border-t border-[var(--color-tron-border)]">
									<td class="tron-text-muted p-2">{capturedReadings.length - 15 + i + 1}</td>
									<td class="tron-text-muted p-2 font-mono text-xs">
										{new Date(reading.timestamp).toLocaleTimeString()}
									</td>
									<td class="tron-heading p-2 font-medium">{formatTemp(reading.temperature)}°C</td>
									<td class="p-2">
										<span
											class="rounded-full px-2 py-0.5 text-xs font-medium
											{inRange
												? 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]'
												: 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]'}"
										>
											{inRange ? 'OK' : 'Out of Range'}
										</span>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				{#if capturedReadings.length > 15}
					<div
						class="tron-text-muted border-t border-[var(--color-tron-border)] p-2 text-center text-xs"
					>
						Showing last 15 of {capturedReadings.length} readings
					</div>
				{/if}
			</div>
		{/if}
	{/if}
</div>
