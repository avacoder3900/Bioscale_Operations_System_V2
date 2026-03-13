<script lang="ts">
	let { data } = $props();

	let showAddModal = $state(false);
	let newName = $state('');
	let newIp = $state('');
	let newPort = $state('31950');
	let newSide = $state('');
	let newLegacyId = $state('');
	let addError = $state('');
	let adding = $state(false);

	const availableRobots = $derived(data.robots.filter((r) => r.lastHealthOk && r.isActive));
	const unavailableRobots = $derived(data.robots.filter((r) => !r.lastHealthOk || !r.isActive));

	function timeSince(iso: string | null): string {
		if (!iso) return 'Never';
		const diff = Date.now() - new Date(iso).getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'Just now';
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		return `${Math.floor(hours / 24)}d ago`;
	}

	async function handleAdd() {
		if (!newName.trim() || !newIp.trim()) return;
		adding = true;
		addError = '';

		try {
			const res = await fetch('/api/opentrons-lab/robots', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: newName.trim(),
					ip: newIp.trim(),
					port: parseInt(newPort) || 31950,
					robotSide: newSide || undefined,
					legacyRobotId: newLegacyId || undefined
				})
			});

			if (!res.ok) {
				const body = await res.json().catch(() => ({ message: 'Failed to add robot' }));
				throw new Error(body.message || `HTTP ${res.status}`);
			}

			showAddModal = false;
			newName = '';
			newIp = '';
			newPort = '31950';
			newSide = '';
			newLegacyId = '';
			window.location.reload();
		} catch (e) {
			addError = e instanceof Error ? e.message : 'Failed to add robot';
		} finally {
			adding = false;
		}
	}

	async function handleIdentify(robotId: string) {
		try {
			await fetch(`/api/opentrons-lab/robots/${robotId}/identify`, { method: 'POST' });
		} catch {
			// silently fail
		}
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-[var(--color-tron-text)]">Devices</h1>
		<button
			onclick={() => { showAddModal = true; }}
			class="rounded-md border border-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)] hover:text-black"
		>
			Add Robot
		</button>
	</div>

	<!-- Available Robots -->
	<div>
		<h2 class="mb-3 text-sm font-medium text-[var(--color-tron-text-secondary)]">
			Available ({availableRobots.length})
		</h2>
		{#if availableRobots.length === 0}
			<p class="py-4 text-sm text-[var(--color-tron-text-secondary)]">No robots currently available.</p>
		{:else}
			<div class="space-y-3">
				{#each availableRobots as robot (robot.robotId)}
					<!-- eslint-disable svelte/no-navigation-without-resolve -->
					<a
						href="/opentrons/devices/{robot.robotId}"
						class="flex items-center gap-4 rounded-lg border border-[var(--color-tron-border)] p-4 transition-colors hover:border-[var(--color-tron-cyan)]"
					>
						<!-- Status dot -->
						<div class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-green-900/30">
							<div class="h-3 w-3 rounded-full bg-green-400"></div>
						</div>

						<!-- Info -->
						<div class="flex-1">
							<h3 class="text-sm font-medium text-[var(--color-tron-text)]">{robot.name}</h3>
							<div class="mt-0.5 flex items-center gap-3 text-xs text-[var(--color-tron-text-secondary)]">
								<span>{robot.robotModel}</span>
								<span>{robot.ip}:{robot.port}</span>
								{#if robot.robotSide}
									<span class="rounded bg-[var(--color-tron-bg-secondary)] px-1.5 py-0.5">{robot.robotSide} side</span>
								{/if}
								{#if robot.robotSerial}
									<span>S/N: {robot.robotSerial}</span>
								{/if}
							</div>
						</div>

						<!-- Health timestamp -->
						<div class="text-right text-xs text-[var(--color-tron-text-secondary)]">
							{timeSince(robot.lastHealthAt)}
						</div>

						<!-- Identify button -->
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							onclick={(e) => { e.preventDefault(); e.stopPropagation(); handleIdentify(robot.robotId); }}
							class="cursor-pointer rounded border border-[var(--color-tron-border)] p-1.5 text-[var(--color-tron-text-secondary)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
							title="Blink lights"
						>
							<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
							</svg>
						</div>
					</a>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				{/each}
			</div>
		{/if}
	</div>

	<!-- Unavailable Robots -->
	{#if unavailableRobots.length > 0}
		<div>
			<h2 class="mb-3 text-sm font-medium text-[var(--color-tron-text-secondary)]">
				Not Available ({unavailableRobots.length})
			</h2>
			<div class="space-y-3">
				{#each unavailableRobots as robot (robot.robotId)}
					<!-- eslint-disable svelte/no-navigation-without-resolve -->
					<a
						href="/opentrons/devices/{robot.robotId}"
						class="flex items-center gap-4 rounded-lg border border-[var(--color-tron-border)] p-4 opacity-60 transition-colors hover:border-[var(--color-tron-border)]"
					>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
						<!-- Status dot -->
						<div class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-red-900/30">
							<div class="h-3 w-3 rounded-full bg-red-400"></div>
						</div>

						<!-- Info -->
						<div class="flex-1">
							<h3 class="text-sm font-medium text-[var(--color-tron-text)]">{robot.name}</h3>
							<div class="mt-0.5 flex items-center gap-3 text-xs text-[var(--color-tron-text-secondary)]">
								<span>{robot.robotModel}</span>
								<span>{robot.ip}:{robot.port}</span>
								{#if !robot.isActive}
									<span class="rounded bg-red-900/30 px-1.5 py-0.5 text-red-400">Deactivated</span>
								{:else}
									<span class="rounded bg-red-900/30 px-1.5 py-0.5 text-red-400">Offline</span>
								{/if}
							</div>
						</div>

						<!-- Last seen -->
						<div class="text-right text-xs text-[var(--color-tron-text-secondary)]">
							Last seen: {timeSince(robot.lastHealthAt)}
						</div>
					</a>
				{/each}
			</div>
		</div>
	{/if}
</div>

<!-- Add Robot Modal -->
{#if showAddModal}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
		onclick={() => { showAddModal = false; }}
	>
		<div
			class="w-full max-w-md rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] p-6"
			onclick={(e) => e.stopPropagation()}
		>
			<h2 class="mb-4 text-lg font-bold text-[var(--color-tron-text)]">Add Robot</h2>

			<div class="space-y-4">
				<div>
					<label class="mb-1 block text-sm text-[var(--color-tron-text-secondary)]" for="robot-name">
						Robot Name
					</label>
					<input
						id="robot-name"
						type="text"
						bind:value={newName}
						placeholder="e.g. Left Robot"
						class="tron-input w-full px-3 py-2"
					/>
				</div>

				<div>
					<label class="mb-1 block text-sm text-[var(--color-tron-text-secondary)]" for="robot-ip">
						IP Address
					</label>
					<input
						id="robot-ip"
						type="text"
						bind:value={newIp}
						placeholder="e.g. 192.168.1.100"
						class="tron-input w-full px-3 py-2"
					/>
				</div>

				<div class="grid grid-cols-2 gap-4">
					<div>
						<label class="mb-1 block text-sm text-[var(--color-tron-text-secondary)]" for="robot-port">
							Port
						</label>
						<input
							id="robot-port"
							type="text"
							bind:value={newPort}
							class="tron-input w-full px-3 py-2"
						/>
					</div>
					<div>
						<label class="mb-1 block text-sm text-[var(--color-tron-text-secondary)]" for="robot-side">
							Side
						</label>
						<select id="robot-side" bind:value={newSide} class="tron-input w-full px-3 py-2">
							<option value="">None</option>
							<option value="left">Left</option>
							<option value="right">Right</option>
						</select>
					</div>
				</div>

				<div>
					<label class="mb-1 block text-sm text-[var(--color-tron-text-secondary)]" for="robot-legacy">
						Legacy Robot ID (optional)
					</label>
					<input
						id="robot-legacy"
						type="text"
						bind:value={newLegacyId}
						placeholder="e.g. robot-1"
						class="tron-input w-full px-3 py-2 text-sm"
					/>
					<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
						Maps to existing wax/reagent filling system
					</p>
				</div>

				{#if addError}
					<p class="text-sm text-[var(--color-tron-error)]">{addError}</p>
				{/if}

				<div class="flex justify-end gap-3">
					<button
						onclick={() => { showAddModal = false; }}
						class="rounded px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:text-[var(--color-tron-text)]"
					>
						Cancel
					</button>
					<button
						onclick={handleAdd}
						disabled={!newName.trim() || !newIp.trim() || adding}
						class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-black transition-opacity disabled:opacity-50"
					>
						{adding ? 'Adding...' : 'Add Robot'}
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}
