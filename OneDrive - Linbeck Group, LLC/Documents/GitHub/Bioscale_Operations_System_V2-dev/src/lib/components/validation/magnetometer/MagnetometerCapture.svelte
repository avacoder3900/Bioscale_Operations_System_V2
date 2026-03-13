<script lang="ts">
	import {
		MagnetometerSerial,
		type MagnetometerReading,
		type ConnectionState
	} from '$lib/services/magnetometer-serial';

	interface Props {
		sessionId: string;
		onSubmit?: (readings: MagnetometerReading[]) => void;
		onError?: (error: Error) => void;
		minReadings?: number;
	}

	let { sessionId, onSubmit, onError, minReadings = 10 }: Props = $props();

	// Serial connection state
	let magnetometer: MagnetometerSerial | null = $state(null);
	let connectionState = $state<ConnectionState>('disconnected');
	let connectionError = $state<string | null>(null);

	// Real-time readings
	let liveReading = $state<MagnetometerReading | null>(null);
	let capturedReadings = $state<MagnetometerReading[]>([]);

	// Capture state
	let isCapturing = $state(false);
	let isSubmitting = $state(false);

	// Computed
	let isConnected = $derived(connectionState === 'connected');
	let canCapture = $derived(isConnected && !isCapturing && capturedReadings.length === 0);
	let canSubmit = $derived(!isSubmitting && capturedReadings.length >= minReadings);
	let isSupported = $derived(MagnetometerSerial.isSupported());

	// Initialize magnetometer service
	function initMagnetometer() {
		if (magnetometer) return magnetometer;

		const mag = new MagnetometerSerial();

		mag.addEventListener((event) => {
			switch (event.type) {
				case 'state':
					connectionState = event.state;
					break;
				case 'connected':
					connectionError = null;
					break;
				case 'disconnected':
					liveReading = null;
					break;
				case 'error':
					connectionError = event.error.message;
					onError?.(event.error);
					break;
				case 'reading':
					liveReading = event.reading;
					if (isCapturing) {
						capturedReadings = [...capturedReadings, event.reading];
					}
					break;
			}
		});

		magnetometer = mag;
		return mag;
	}

	async function connect() {
		connectionError = null;
		const mag = initMagnetometer();
		try {
			await mag.connect();
		} catch (err) {
			connectionError = err instanceof Error ? err.message : 'Connection failed';
		}
	}

	async function disconnect() {
		if (magnetometer) {
			await magnetometer.disconnect();
		}
	}

	function startCapture() {
		capturedReadings = [];
		isCapturing = true;
	}

	function stopCapture() {
		isCapturing = false;
	}

	function clearCapture() {
		capturedReadings = [];
		isCapturing = false;
	}

	async function submitReadings() {
		if (capturedReadings.length < minReadings) {
			connectionError = `Need at least ${minReadings} readings`;
			return;
		}

		isSubmitting = true;
		connectionError = null;

		try {
			// Call the API to submit readings
			const response = await fetch('/api/validation/magnetometer', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					sessionId,
					sourceType: 'serial',
					rawData: capturedReadings
				})
			});

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({ message: 'Submission failed' }));
				throw new Error(errorData.message || `HTTP ${response.status}`);
			}

			const result = await response.json();
			onSubmit?.(capturedReadings);

			// Redirect to results page
			window.location.href = `/spu/validation/magnetometer/${sessionId}`;
		} catch (err) {
			connectionError = err instanceof Error ? err.message : 'Submission failed';
			onError?.(err instanceof Error ? err : new Error('Submission failed'));
		} finally {
			isSubmitting = false;
		}
	}

	function formatMagnitude(value: number): string {
		return value.toFixed(2);
	}

	function formatAxis(value: number): string {
		return value.toFixed(3);
	}

	// Cleanup on unmount
	$effect(() => {
		return () => {
			if (magnetometer) {
				magnetometer.disconnect();
			}
		};
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
		<!-- Connection Controls -->
		<div class="tron-card p-4">
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-3">
					<!-- Status Indicator -->
					<div
						class="h-3 w-3 rounded-full transition-all duration-300 {isConnected
							? 'bg-[var(--color-tron-green)] shadow-[0_0_8px_var(--color-tron-green)]'
							: connectionState === 'connecting'
								? 'animate-pulse bg-[var(--color-tron-orange)]'
								: 'bg-[var(--color-tron-text-secondary)]'}"
					></div>
					<span class="tron-heading">
						{#if connectionState === 'connecting'}
							Connecting...
						{:else if isConnected}
							Connected
						{:else if connectionState === 'error'}
							Connection Error
						{:else}
							Not Connected
						{/if}
					</span>
				</div>

				{#if isConnected}
					<button onclick={disconnect} class="tron-btn-secondary px-4 py-2 text-sm">
						Disconnect
					</button>
				{:else}
					<button
						onclick={connect}
						disabled={connectionState === 'connecting'}
						class="tron-btn-primary flex items-center gap-2 px-4 py-2 text-sm disabled:opacity-50"
					>
						{#if connectionState === 'connecting'}
							<svg class="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
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
						{:else}
							<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M13 10V3L4 14h7v7l9-11h-7z"
								/>
							</svg>
						{/if}
						Connect
					</button>
				{/if}
			</div>

			{#if connectionError}
				<div class="mt-3 flex items-start gap-2 text-sm text-[var(--color-tron-red)]">
					<svg class="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
						/>
					</svg>
					<span>{connectionError}</span>
				</div>
			{/if}
		</div>

		<!-- Live Reading Display -->
		{#if isConnected}
			<div class="tron-card p-6">
				<h3 class="tron-heading mb-4 text-lg font-semibold">Live Reading</h3>

				{#if liveReading}
					<div class="grid grid-cols-2 gap-4 md:grid-cols-4">
						<!-- Magnitude -->
						<div class="rounded-lg bg-[var(--color-tron-purple)]/10 p-4 text-center">
							<div class="tron-text-muted text-xs uppercase">Magnitude</div>
							<div class="tron-heading mt-1 text-2xl font-bold text-[var(--color-tron-purple)]">
								{formatMagnitude(liveReading.magnitude)} <span class="text-sm">µT</span>
							</div>
						</div>

						<!-- X Axis -->
						<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
							<div class="tron-text-muted text-xs uppercase">X Axis</div>
							<div class="tron-heading mt-1 text-xl font-bold">{formatAxis(liveReading.x)}</div>
						</div>

						<!-- Y Axis -->
						<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
							<div class="tron-text-muted text-xs uppercase">Y Axis</div>
							<div class="tron-heading mt-1 text-xl font-bold">{formatAxis(liveReading.y)}</div>
						</div>

						<!-- Z Axis -->
						<div class="rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4 text-center">
							<div class="tron-text-muted text-xs uppercase">Z Axis</div>
							<div class="tron-heading mt-1 text-xl font-bold">{formatAxis(liveReading.z)}</div>
						</div>
					</div>
				{:else}
					<div class="py-8 text-center">
						<svg
							class="mx-auto h-12 w-12 animate-pulse text-[var(--color-tron-text-secondary)]"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M13 10V3L4 14h7v7l9-11h-7z"
							/>
						</svg>
						<p class="tron-text-muted mt-4">Waiting for magnetometer data...</p>
					</div>
				{/if}
			</div>
		{/if}

		<!-- Capture Controls -->
		{#if isConnected}
			<div class="tron-card p-4">
				<div class="flex items-center justify-between">
					<div>
						<span class="tron-heading font-medium">Data Capture</span>
						<span class="tron-text-muted ml-2 text-sm">
							{capturedReadings.length} readings
							{#if capturedReadings.length < minReadings}
								<span class="text-[var(--color-tron-orange)]">(need {minReadings})</span>
							{:else}
								<span class="text-[var(--color-tron-green)]">(ready)</span>
							{/if}
						</span>
					</div>

					<div class="flex items-center gap-2">
						{#if isCapturing}
							<button onclick={stopCapture} class="tron-btn-secondary px-4 py-2 text-sm">
								Stop
							</button>
						{:else if capturedReadings.length > 0}
							<button onclick={clearCapture} class="tron-btn-secondary px-4 py-2 text-sm">
								Clear
							</button>
						{:else}
							<button
								onclick={startCapture}
								disabled={!canCapture}
								class="tron-btn-primary flex items-center gap-2 px-4 py-2 text-sm disabled:opacity-50"
							>
								<svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
									<circle cx="12" cy="12" r="8" />
								</svg>
								Start Capture
							</button>
						{/if}
					</div>
				</div>

				<!-- Capture Progress -->
				{#if isCapturing || capturedReadings.length > 0}
					<div class="mt-4">
						<div class="h-2 overflow-hidden rounded-full bg-[var(--color-tron-bg-tertiary)]">
							<div
								class="h-full transition-all duration-300 {capturedReadings.length >= minReadings
									? 'bg-[var(--color-tron-green)]'
									: 'bg-[var(--color-tron-purple)]'}"
								style="width: {Math.min((capturedReadings.length / minReadings) * 100, 100)}%"
							></div>
						</div>
					</div>
				{/if}
			</div>
		{/if}

		<!-- Data Preview -->
		{#if capturedReadings.length > 0}
			<div class="tron-card">
				<div class="border-b border-[var(--color-tron-border)] p-4">
					<h3 class="tron-heading font-semibold">Captured Data Preview</h3>
				</div>

				<div class="max-h-48 overflow-y-auto">
					<table class="w-full text-sm">
						<thead class="sticky top-0 bg-[var(--color-tron-bg-secondary)]">
							<tr class="text-left">
								<th class="tron-text-muted p-2">#</th>
								<th class="tron-text-muted p-2">Magnitude</th>
								<th class="tron-text-muted p-2">X</th>
								<th class="tron-text-muted p-2">Y</th>
								<th class="tron-text-muted p-2">Z</th>
							</tr>
						</thead>
						<tbody>
							{#each capturedReadings.slice(-20) as reading, i (reading.timestamp)}
								<tr class="border-t border-[var(--color-tron-border)]">
									<td class="tron-text-muted p-2">{capturedReadings.length - 20 + i + 1}</td>
									<td class="tron-heading p-2 font-medium">{formatMagnitude(reading.magnitude)}</td>
									<td class="p-2">{formatAxis(reading.x)}</td>
									<td class="p-2">{formatAxis(reading.y)}</td>
									<td class="p-2">{formatAxis(reading.z)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				{#if capturedReadings.length > 20}
					<div
						class="tron-text-muted border-t border-[var(--color-tron-border)] p-2 text-center text-xs"
					>
						Showing last 20 of {capturedReadings.length} readings
					</div>
				{/if}
			</div>
		{/if}

		<!-- Submit Button -->
		{#if capturedReadings.length > 0}
			<div class="flex justify-end">
				<button
					onclick={submitReadings}
					disabled={!canSubmit}
					class="tron-btn-primary flex items-center gap-2 px-6 py-3 text-lg font-semibold disabled:cursor-not-allowed disabled:opacity-50"
				>
					{#if isSubmitting}
						<svg class="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
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
						Processing...
					{:else}
						<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
							/>
						</svg>
						Submit for Analysis
					{/if}
				</button>
			</div>
		{/if}
	{/if}
</div>
