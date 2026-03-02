<script lang="ts">
	interface Props {
		data: {
			recentSessions: Array<{
				id: string;
				status: string;
				barcode: string | null;
				createdAt: string;
				hasResult: boolean;
			}>;
			sessionsWithData: Array<{
				sessionId: string;
				testType: string;
				createdAt: string;
			}>;
		};
	}

	let { data }: Props = $props();

	// Data source selection
	type DataSource = 'serial' | 'database';
	let dataSource = $state<DataSource>('serial');

	// Serial port state
	let serialConnected = $state(false);
	let serialConnecting = $state(false);
	let serialError = $state<string | null>(null);
	let serialSupported = $state(typeof navigator !== 'undefined' && 'serial' in navigator);

	// Database import state
	let selectedRecordId = $state<string | null>(null);

	// Computed: Can start test
	let canStartTest = $derived(
		dataSource === 'serial' ? serialConnected : selectedRecordId !== null
	);

	// Serial port connection (Web Serial API)
	async function connectSerial() {
		if (!serialSupported || !navigator.serial) {
			serialError = 'Web Serial API is not supported in this browser. Use Chrome or Edge.';
			return;
		}

		serialConnecting = true;
		serialError = null;

		try {
			// Request port access
			const port = await navigator.serial.requestPort();

			// Open with typical magnetometer settings
			await port.open({ baudRate: 115200 });

			serialConnected = true;

			// Store port reference for later use (will be handled by capture component)
			// For now, just close it - MAG-003 will handle full serial implementation
			await port.close();
		} catch (err) {
			if (err instanceof Error) {
				if (err.name === 'NotFoundError') {
					serialError = 'No serial port selected. Please select a device.';
				} else {
					serialError = err.message;
				}
			} else {
				serialError = 'Failed to connect to serial port';
			}
			serialConnected = false;
		} finally {
			serialConnecting = false;
		}
	}

	function disconnectSerial() {
		serialConnected = false;
		serialError = null;
	}

	function formatDate(dateStr: string): string {
		return new Date(dateStr).toLocaleString();
	}

	function handleStartTest() {
		// Navigate to test session - MAG-002 will handle session creation
		if (dataSource === 'serial') {
			// Will be handled by form action in MAG-002
			console.log('Starting serial test...');
		} else if (selectedRecordId) {
			// Will be handled by form action in MAG-002
			console.log('Starting database import test with record:', selectedRecordId);
		}
	}
</script>

<div class="space-y-8">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Magnetometer Test</h1>
			<p class="tron-text-muted mt-1">Validate magnet field strength and polarity</p>
		</div>
		<a
			href="/spu/validation/magnetometer/history"
			class="tron-btn-secondary flex items-center gap-2 px-4 py-2"
		>
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
				/>
			</svg>
			View History
		</a>
	</div>

	<!-- Data Source Selection -->
	<div class="tron-card p-6">
		<h2 class="tron-heading mb-4 text-lg font-semibold">Data Source</h2>
		<p class="tron-text-muted mb-6 text-sm">
			Select how to capture magnetometer data for this test
		</p>

		<div class="grid gap-4 md:grid-cols-2">
			<!-- Serial Port Option -->
			<label
				class="tron-card cursor-pointer p-4 transition-all duration-200 {dataSource === 'serial'
					? 'border-[var(--color-tron-purple)] bg-[var(--color-tron-purple)]/5'
					: 'hover:border-[var(--color-tron-purple)]/50'}"
			>
				<div class="flex items-start gap-4">
					<input
						type="radio"
						name="dataSource"
						value="serial"
						bind:group={dataSource}
						class="mt-1 h-4 w-4 accent-[var(--color-tron-purple)]"
					/>
					<div class="flex-1">
						<div class="flex items-center gap-2">
							<svg
								class="h-5 w-5 text-[var(--color-tron-purple)]"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0"
								/>
							</svg>
							<span class="tron-heading font-medium">Serial Port (Bluetooth)</span>
						</div>
						<p class="tron-text-muted mt-1 text-sm">
							Connect to magnetometer via Bluetooth serial connection for real-time data capture
						</p>
					</div>
				</div>
			</label>

			<!-- Database Import Option -->
			<label
				class="tron-card cursor-pointer p-4 transition-all duration-200 {dataSource === 'database'
					? 'border-[var(--color-tron-purple)] bg-[var(--color-tron-purple)]/5'
					: 'hover:border-[var(--color-tron-purple)]/50'}"
			>
				<div class="flex items-start gap-4">
					<input
						type="radio"
						name="dataSource"
						value="database"
						bind:group={dataSource}
						class="mt-1 h-4 w-4 accent-[var(--color-tron-purple)]"
					/>
					<div class="flex-1">
						<div class="flex items-center gap-2">
							<svg
								class="h-5 w-5 text-[var(--color-tron-purple)]"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"
								/>
							</svg>
							<span class="tron-heading font-medium">Database Import</span>
						</div>
						<p class="tron-text-muted mt-1 text-sm">
							Import magnetometer data from a previous database record
						</p>
					</div>
				</div>
			</label>
		</div>
	</div>

	<!-- Serial Port Configuration (when selected) -->
	{#if dataSource === 'serial'}
		<div class="tron-card p-6">
			<h2 class="tron-heading mb-4 text-lg font-semibold">Serial Connection</h2>

			{#if !serialSupported}
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
							Web Serial API is not available. Please use Chrome, Edge, or another Chromium-based
							browser.
						</p>
					</div>
				</div>
			{:else}
				<div class="space-y-4">
					<!-- Connection Status -->
					<div class="flex items-center justify-between">
						<div class="flex items-center gap-3">
							<div
								class="h-3 w-3 rounded-full {serialConnected
									? 'bg-[var(--color-tron-green)] shadow-[0_0_8px_var(--color-tron-green)]'
									: 'bg-[var(--color-tron-text-secondary)]'}"
							></div>
							<span class="tron-heading">
								{serialConnected ? 'Connected' : 'Not Connected'}
							</span>
						</div>

						{#if serialConnected}
							<button onclick={disconnectSerial} class="tron-btn-secondary px-4 py-2 text-sm">
								Disconnect
							</button>
						{:else}
							<button
								onclick={connectSerial}
								disabled={serialConnecting}
								class="tron-btn-primary flex items-center gap-2 px-4 py-2 text-sm disabled:opacity-50"
							>
								{#if serialConnecting}
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
											d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
										></path>
									</svg>
									Connecting...
								{:else}
									<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M13 10V3L4 14h7v7l9-11h-7z"
										/>
									</svg>
									Connect
								{/if}
							</button>
						{/if}
					</div>

					{#if serialError}
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
								<p class="tron-heading text-sm font-medium">Connection Error</p>
								<p class="tron-text-muted text-sm">{serialError}</p>
							</div>
						</div>
					{/if}

					<p class="tron-text-muted text-sm">
						Click "Connect" to pair with your Bluetooth magnetometer. The device will appear as a
						serial port.
					</p>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Database Record Selection (when selected) -->
	{#if dataSource === 'database'}
		<div class="tron-card p-6">
			<h2 class="tron-heading mb-4 text-lg font-semibold">Select Record</h2>

			{#if data.sessionsWithData.length === 0}
				<div class="py-8 text-center">
					<svg
						class="mx-auto h-12 w-12 text-[var(--color-tron-text-secondary)]"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4"
						/>
					</svg>
					<p class="tron-text-muted mt-4">No magnetometer data records available</p>
					<p class="tron-text-muted mt-1 text-sm">
						Complete a serial capture first to create records for import
					</p>
				</div>
			{:else}
				<div class="space-y-2">
					{#each data.sessionsWithData as record (record.sessionId)}
						<label
							class="tron-card flex cursor-pointer items-center gap-4 p-4 transition-all duration-200 {selectedRecordId ===
							record.sessionId
								? 'border-[var(--color-tron-purple)] bg-[var(--color-tron-purple)]/5'
								: 'hover:border-[var(--color-tron-purple)]/50'}"
						>
							<input
								type="radio"
								name="recordId"
								value={record.sessionId}
								bind:group={selectedRecordId}
								class="h-4 w-4 accent-[var(--color-tron-purple)]"
							/>
							<div class="flex-1">
								<span class="tron-heading font-medium">{record.sessionId.slice(0, 8)}...</span>
								<span class="tron-text-muted ml-2 text-sm">({record.testType})</span>
							</div>
							<span class="tron-text-muted text-sm">{formatDate(record.createdAt)}</span>
						</label>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	<!-- Start Test Button -->
	<div class="flex justify-end">
		<form method="POST" action="?/initiate">
			<input type="hidden" name="dataSource" value={dataSource} />
			{#if dataSource === 'database' && selectedRecordId}
				<input type="hidden" name="recordId" value={selectedRecordId} />
			{/if}
			<button
				type="submit"
				disabled={!canStartTest}
				class="tron-btn-primary flex items-center gap-2 px-6 py-3 text-lg font-semibold disabled:cursor-not-allowed disabled:opacity-50"
			>
				<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
				Start Test
			</button>
		</form>
	</div>

	<!-- Recent Sessions -->
	{#if data.recentSessions.length > 0}
		<div class="tron-card">
			<div class="border-b border-[var(--color-tron-border)] p-4">
				<h2 class="tron-heading text-lg font-semibold">Recent Magnetometer Tests</h2>
			</div>
			<div class="divide-y divide-[var(--color-tron-border)]">
				{#each data.recentSessions.slice(0, 5) as session (session.id)}
					<a
						href="/spu/validation/magnetometer/{session.id}"
						class="flex items-center justify-between p-4 transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
					>
						<div>
							<span class="tron-heading font-medium"
								>{session.barcode ?? session.id.slice(0, 8)}</span
							>
							<span class="tron-text-muted ml-2 text-sm">{formatDate(session.createdAt)}</span>
						</div>
						<span
							class="rounded-full px-2 py-1 text-xs font-medium
								{session.status === 'completed'
								? 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]'
								: session.status === 'failed'
									? 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]'
									: 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)]'}"
						>
							{session.status}
						</span>
					</a>
				{/each}
			</div>
		</div>
	{/if}
</div>
