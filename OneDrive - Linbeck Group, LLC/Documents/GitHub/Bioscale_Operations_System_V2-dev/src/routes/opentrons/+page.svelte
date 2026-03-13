<script lang="ts">
	let { data } = $props();

	let sortBy = $state<'alpha' | 'recent'>('recent');
	let showImportModal = $state(false);
	let selectedRobotId = $state('');
	let importFile = $state<File | null>(null);
	let importing = $state(false);
	let importError = $state('');

	const sortedProtocols = $derived(() => {
		const list = [...data.protocolRecords];
		if (sortBy === 'alpha') {
			list.sort((a, b) => a.protocolName.localeCompare(b.protocolName));
		} else {
			list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
		}
		return list;
	});

	function getInstrumentBadge(pipettes: unknown): string {
		if (!pipettes || !Array.isArray(pipettes)) return 'OT-2';
		const names = (pipettes as { pipetteName: string }[]).map((p) => p.pipetteName);
		return names.join(', ') || 'OT-2';
	}

	function formatDate(iso: string): string {
		const d = new Date(iso);
		return `Updated ${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
	}

	function getRobotName(robotId: string): string {
		const robot = data.robots.find((r) => r.robotId === robotId);
		return robot?.name ?? robotId;
	}

	async function handleImport() {
		if (!importFile || !selectedRobotId) return;
		importing = true;
		importError = '';

		try {
			const formData = new FormData();
			formData.append('protocolFile', importFile);

			const res = await fetch(`/api/opentrons-lab/robots/${selectedRobotId}/protocols`, {
				method: 'POST',
				body: formData
			});

			if (!res.ok) {
				const body = await res.json().catch(() => ({ message: 'Upload failed' }));
				throw new Error(body.message || `HTTP ${res.status}`);
			}

			showImportModal = false;
			importFile = null;
			// Reload page to show new protocol
			window.location.reload();
		} catch (e) {
			importError = e instanceof Error ? e.message : 'Upload failed';
		} finally {
			importing = false;
		}
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-[var(--color-tron-text)]">Protocols</h1>
		<div class="flex items-center gap-4">
			<div class="flex items-center gap-2 text-sm">
				<span class="text-[var(--color-tron-text-secondary)]">Sort by</span>
				<select
					bind:value={sortBy}
					class="tron-input px-2 py-1 text-sm"
				>
					<option value="alpha">Alphabetical</option>
					<option value="recent">Recent</option>
				</select>
			</div>
			<button
				onclick={() => { showImportModal = true; }}
				class="rounded-md border border-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)] hover:text-black"
			>
				Import
			</button>
		</div>
	</div>

	<!-- Protocol list -->
	{#if sortedProtocols().length === 0}
		<div
			class="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-tron-border)] py-16"
		>
			<svg class="mb-4 h-12 w-12 text-[var(--color-tron-text-secondary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
			</svg>
			<p class="mb-2 text-lg font-medium text-[var(--color-tron-text)]">No protocols uploaded</p>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				Import a protocol file (.py or .json) to get started
			</p>
		</div>
	{:else}
		<div class="space-y-3">
			{#each sortedProtocols() as protocol (protocol.opentronsProtocolId)}
				<!-- eslint-disable svelte/no-navigation-without-resolve -->
				<a
					href="/opentrons/protocols/{protocol.robotId}/{protocol.opentronsProtocolId}"
					class="flex items-center gap-4 rounded-lg border border-[var(--color-tron-border)] p-4 transition-colors hover:border-[var(--color-tron-cyan)]"
				>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
					<!-- Deck thumbnail -->
					<div class="flex h-14 w-16 flex-shrink-0 items-center justify-center rounded bg-[var(--color-tron-bg-secondary)]">
						<div class="grid grid-cols-3 gap-0.5">
							<!-- eslint-disable-next-line @typescript-eslint/no-unused-vars -->
						{#each Array(9) as _, i (i)}
								<div class="h-2 w-2 rounded-sm bg-[var(--color-tron-border)]"></div>
							{/each}
						</div>
					</div>

					<!-- Info -->
					<div class="flex-1">
						<h3 class="text-sm font-medium text-[var(--color-tron-text)]">
							{protocol.protocolName}
						</h3>
						<div class="mt-1 flex items-center gap-3 text-xs text-[var(--color-tron-text-secondary)]">
							<span>Robot: <span class="text-[var(--color-tron-text)]">OT-2</span></span>
							<span>Instruments:
								<span class="rounded bg-[var(--color-tron-bg-secondary)] px-1.5 py-0.5 text-[var(--color-tron-text)]">
									{getInstrumentBadge(protocol.pipettesRequired)}
								</span>
							</span>
							<span class="text-[var(--color-tron-text-secondary)]">
								on {getRobotName(protocol.robotId)}
							</span>
						</div>
					</div>

					<!-- Date -->
					<div class="text-right text-xs text-[var(--color-tron-text-secondary)]">
						{formatDate(protocol.updatedAt)}
					</div>
				</a>
			{/each}
		</div>
	{/if}

	<p class="text-center text-sm text-[var(--color-tron-text-secondary)]">
		Create or download a new protocol
	</p>
</div>

<!-- Import Modal -->
{#if showImportModal}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
		onclick={() => { showImportModal = false; }}
	>
		<div
			class="w-full max-w-md rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-6"
			onclick={(e) => e.stopPropagation()}
		>
			<h2 class="mb-4 text-lg font-bold text-[var(--color-tron-text)]">Import Protocol</h2>

			<div class="space-y-4">
				<div>
					<label class="mb-1 block text-sm text-[var(--color-tron-text-secondary)]" for="robot-select">
						Target Robot
					</label>
					<select id="robot-select" bind:value={selectedRobotId} class="tron-input w-full px-3 py-2">
						<option value="">Select a robot...</option>
						{#each data.robots as robot (robot.robotId)}
							<option value={robot.robotId}>
								{robot.name} ({robot.ip}) {robot.lastHealthOk ? '' : '- offline'}
							</option>
						{/each}
					</select>
				</div>

				<div>
					<label class="mb-1 block text-sm text-[var(--color-tron-text-secondary)]" for="protocol-file">
						Protocol File (.py or .json)
					</label>
					<input
						id="protocol-file"
						type="file"
						accept=".py,.json"
						class="tron-input w-full px-3 py-2 text-sm"
						onchange={(e) => {
							const target = e.target as HTMLInputElement;
							importFile = target.files?.[0] ?? null;
						}}
					/>
				</div>

				{#if importError}
					<p class="text-sm text-[var(--color-tron-error)]">{importError}</p>
				{/if}

				<div class="flex justify-end gap-3">
					<button
						onclick={() => { showImportModal = false; }}
						class="rounded px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-text)]"
					>
						Cancel
					</button>
					<button
						onclick={handleImport}
						disabled={!importFile || !selectedRobotId || importing}
						class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-black transition-opacity disabled:opacity-50"
					>
						{importing ? 'Uploading...' : 'Import'}
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}
