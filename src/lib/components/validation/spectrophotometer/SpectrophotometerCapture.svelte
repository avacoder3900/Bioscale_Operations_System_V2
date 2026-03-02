<script lang="ts">
	import {
		SpectrophotometerSerial,
		type ConnectionState,
		type DeviceInfo,
		type AS7341Reading,
		type ValidationStep
	} from '$lib/services/spectrophotometer-serial';

	interface Props {
		sessionId: string;
		onComplete?: () => void;
	}

	let { sessionId, onComplete }: Props = $props();

	// Serial connection state
	let serial: SpectrophotometerSerial | null = $state(null);
	let connectionState = $state<ConnectionState>('disconnected');
	let connectionError = $state<string | null>(null);

	// Device info
	let deviceInfo = $state<DeviceInfo | null>(null);

	// Validation sequence state
	let isRunning = $state(false);
	let isSubmitting = $state(false);
	let currentStep = $state<ValidationStep | null>(null);
	let completedReadings = $state<AS7341Reading[]>([]);
	let sequenceError = $state<string | null>(null);
	let testComplete = $state(false);

	// Computed
	let isConnected = $derived(connectionState === 'connected');
	let isSupported = $derived(SpectrophotometerSerial.isSupported());
	let canRunTest = $derived(isConnected && !isRunning && !testComplete);

	function initSerial() {
		if (serial) return serial;

		const s = new SpectrophotometerSerial();

		s.addEventListener((event) => {
			switch (event.type) {
				case 'state':
					connectionState = event.state;
					break;
				case 'connected':
					connectionError = null;
					break;
				case 'disconnected':
					deviceInfo = null;
					break;
				case 'error':
					connectionError = event.error.message;
					break;
				case 'progress':
					currentStep = event.step;
					break;
			}
		});

		serial = s;
		return s;
	}

	async function connect() {
		connectionError = null;
		sequenceError = null;
		const s = initSerial();
		try {
			await s.connect();
		} catch (err) {
			connectionError = err instanceof Error ? err.message : 'Connection failed';
		}
	}

	async function disconnect() {
		if (serial) {
			await serial.disconnect();
		}
	}

	async function runTest() {
		if (!serial || !isConnected) return;

		isRunning = true;
		sequenceError = null;
		completedReadings = [];

		try {
			const result = await serial.runValidationSequence();
			deviceInfo = result.deviceInfo;
			completedReadings = result.readings;

			// Submit to API
			isSubmitting = true;
			currentStep = { step: 'complete', message: 'Submitting results...' };

			const response = await fetch('/api/validation/spectrophotometer', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					sessionId,
					channelReadings: result.readings,
					deviceInfo: result.deviceInfo
				})
			});

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({ message: 'Submission failed' }));
				throw new Error(errorData.message || `HTTP ${response.status}`);
			}

			testComplete = true;
			currentStep = { step: 'complete', message: 'Test complete!' };

			// Disconnect and reload
			await disconnect();
			onComplete?.();
			window.location.reload();
		} catch (err) {
			sequenceError = err instanceof Error ? err.message : 'Test sequence failed';
		} finally {
			isRunning = false;
			isSubmitting = false;
		}
	}

	function getStepIcon(step: ValidationStep): string {
		switch (step.step) {
			case 'device_info':
				return 'info';
			case 'status_check':
				return 'check';
			case 'laser_on':
				return 'zap';
			case 'reading':
				return 'eye';
			case 'laser_off':
				return 'zap-off';
			case 'reset':
				return 'rotate';
			case 'complete':
				return 'check-circle';
			default:
				return 'loader';
		}
	}

	// Cleanup on unmount
	$effect(() => {
		return () => {
			if (serial) {
				serial.disconnect();
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
					Web Serial API is required for device connection. Please use Chrome, Edge, or another
					Chromium-based browser.
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
							Connected to Device
						{:else if connectionState === 'error'}
							Connection Error
						{:else}
							Not Connected
						{/if}
					</span>
				</div>

				{#if isConnected}
					<button
						onclick={disconnect}
						disabled={isRunning}
						class="tron-btn-secondary px-4 py-2 text-sm disabled:opacity-50"
					>
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
						Connect to Device
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

		<!-- Device Info -->
		{#if deviceInfo}
			<div class="tron-card p-4">
				<h3 class="tron-heading mb-3 font-semibold">Device Information</h3>
				<div class="grid grid-cols-3 gap-4">
					<div>
						<span class="tron-text-muted block text-xs uppercase">Device ID</span>
						<span class="tron-heading font-mono text-sm font-medium">{deviceInfo.deviceId}</span>
					</div>
					<div>
						<span class="tron-text-muted block text-xs uppercase">Firmware</span>
						<span class="tron-heading text-sm font-medium">{deviceInfo.firmwareVersion}</span>
					</div>
					<div>
						<span class="tron-text-muted block text-xs uppercase">Device OS</span>
						<span class="tron-heading text-sm font-medium">{deviceInfo.deviceOS}</span>
					</div>
				</div>
			</div>
		{/if}

		<!-- Run Test Button -->
		{#if isConnected && !isRunning && !testComplete}
			<div class="tron-card border-[var(--color-tron-cyan)] p-8 text-center">
				<div class="mx-auto mb-4 w-fit rounded-full bg-[var(--color-tron-cyan)]/10 p-4">
					<svg
						class="h-12 w-12 text-[var(--color-tron-cyan)]"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
						/>
					</svg>
				</div>
				<h3 class="tron-heading mb-2 text-lg font-semibold">Ready to Run Validation</h3>
				<p class="tron-text-muted mx-auto mb-6 max-w-md text-sm">
					The device is connected. This will automatically cycle through all three laser channels
					(A, B, C), take spectrophotometer readings, and determine pass/fail.
				</p>
				<button
					onclick={runTest}
					disabled={!canRunTest}
					class="tron-btn-primary inline-flex items-center gap-3 px-8 py-4 text-lg font-semibold transition-all hover:scale-105 disabled:opacity-50"
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
					Run Validation Test
				</button>
			</div>
		{/if}

		<!-- Progress Display -->
		{#if isRunning || testComplete}
			<div class="tron-card p-6">
				<h3 class="tron-heading mb-4 font-semibold">
					{testComplete ? 'Test Complete' : 'Running Validation...'}
				</h3>

				{#if currentStep}
					<div class="flex items-center gap-3 rounded-lg bg-[var(--color-tron-bg-tertiary)] p-4">
						{#if isRunning && !testComplete}
							<svg class="h-5 w-5 animate-spin text-[var(--color-tron-cyan)]" fill="none" viewBox="0 0 24 24">
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
							<svg
								class="h-5 w-5 text-[var(--color-tron-green)]"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
								/>
							</svg>
						{/if}
						<span class="tron-heading">{currentStep.message}</span>
					</div>
				{/if}

				<!-- Captured Readings Table -->
				{#if completedReadings.length > 0}
					<div class="mt-4">
						<h4 class="tron-text-muted mb-2 text-xs uppercase">Captured Readings</h4>
						<div class="overflow-x-auto">
							<table class="w-full text-sm">
								<thead>
									<tr class="text-left">
										<th class="tron-text-muted p-2">Laser</th>
										<th class="tron-text-muted p-2">F1 (415)</th>
										<th class="tron-text-muted p-2">F2 (445)</th>
										<th class="tron-text-muted p-2">F3 (480)</th>
										<th class="tron-text-muted p-2">F4 (515)</th>
										<th class="tron-text-muted p-2">F5 (555)</th>
										<th class="tron-text-muted p-2">F6 (590)</th>
										<th class="tron-text-muted p-2">F7 (630)</th>
										<th class="tron-text-muted p-2">F8 (680)</th>
										<th class="tron-text-muted p-2">CLR</th>
										<th class="tron-text-muted p-2">NIR</th>
									</tr>
								</thead>
								<tbody>
									{#each completedReadings as reading (reading.laser)}
										<tr class="border-t border-[var(--color-tron-border)]">
											<td class="p-2 font-medium text-[var(--color-tron-cyan)]">{reading.laser}</td>
											<td class="p-2 font-mono">{reading.f1}</td>
											<td class="p-2 font-mono">{reading.f2}</td>
											<td class="p-2 font-mono">{reading.f3}</td>
											<td class="p-2 font-mono">{reading.f4}</td>
											<td class="p-2 font-mono">{reading.f5}</td>
											<td class="p-2 font-mono">{reading.f6}</td>
											<td class="p-2 font-mono">{reading.f7}</td>
											<td class="p-2 font-mono">{reading.f8}</td>
											<td class="p-2 font-mono">{reading.clear}</td>
											<td class="p-2 font-mono">{reading.nir}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>
				{/if}
			</div>
		{/if}

		<!-- Sequence Error -->
		{#if sequenceError}
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
						d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
					/>
				</svg>
				<div>
					<p class="tron-heading font-medium">Test Failed</p>
					<p class="tron-text-muted mt-1 text-sm">{sequenceError}</p>
					{#if !isRunning}
						<button
							onclick={runTest}
							disabled={!canRunTest}
							class="tron-btn-secondary mt-3 px-4 py-2 text-sm"
						>
							Retry Test
						</button>
					{/if}
				</div>
			</div>
		{/if}
	{/if}
</div>
