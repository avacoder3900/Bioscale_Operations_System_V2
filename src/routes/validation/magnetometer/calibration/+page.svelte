<script lang="ts">
	import { enhance } from '$app/forms';
	import TronCard from '$lib/components/ui/TronCard.svelte';
	import TronButton from '$lib/components/ui/TronButton.svelte';

	interface Props {
		data: {
			spus: { id: string; udi: string; particleDeviceId: string | null; status: string }[];
			calibrations: any[];
			firmware: {
				magStart: number;
				numWells: number;
				stageLimit: number;
				stepDelay: number;
				currentWellMove: number[];
			};
		};
		form: any;
	}

	let { data, form }: Props = $props();

	const fw = data.firmware;
	// Nominal absolute position of each well from the current firmware geometry
	const nominal: number[] = fw.currentWellMove.reduce<number[]>((acc, m) => {
		acc.push((acc.length ? acc[acc.length - 1] : fw.magStart) + m);
		return acc;
	}, []);

	let selectedSpuId = $state('');
	let busy = $state(false);
	let homed = $state(false);
	let position = $state<number | null>(null);
	let apiError = $state('');
	let saving = $state(false);
	let customJog = $state(200);
	let notes = $state('');
	let captured = $state<(number | null)[]>(Array(fw.numWells).fill(null));
	let testResult = $state<{ well: number; position: number } | null>(null);
	// Live telemetry read straight off the device while a move is in flight
	let moving = $state(false);
	let livePosition = $state<number | null>(null);

	const selectedSpu = $derived(data.spus.find((s) => s.id === selectedSpuId));
	const allCaptured = $derived(captured.every((p) => p !== null));
	const wellMove = $derived(
		allCaptured
			? captured.map((p, i) => (i === 0 ? (p as number) - fw.magStart : (p as number) - (captured[i - 1] as number)))
			: null
	);
	const bcodeLines = $derived(wellMove ? wellMove.map((m) => `2,${m},${fw.stepDelay}`) : null);

	const JOG_STEPS = [-1000, -100, -25, 25, 100, 1000];

	const LIVE_POLL_MS = 400;

	/**
	 * Poll stage_pos/stage_moving until the move finishes. Runs alongside the
	 * blocking stage_control call rather than after it, so the operator sees the
	 * stage travel instead of just its final resting place. Every failure mode
	 * here is swallowed: the authoritative position is whatever stage_control
	 * returns, and a flaky sample must never surface as a move error.
	 */
	async function trackMotion(signal: { done: boolean }) {
		while (!signal.done) {
			await new Promise((r) => setTimeout(r, LIVE_POLL_MS));
			if (signal.done) break;
			try {
				const res = await fetch(
					`/api/validation/magnetometer/calibrate/live?spuId=${encodeURIComponent(selectedSpuId)}`
				);
				if (!res.ok) continue;
				const body = await res.json();
				if (signal.done) break;
				if (typeof body.position === 'number') livePosition = body.position;
				moving = Boolean(body.moving);
			} catch {
				// ignore — next tick tries again
			}
		}
	}

	async function call(action: 'pos' | 'home' | 'jog' | 'goto', microns?: number): Promise<number | null> {
		if (!selectedSpuId || busy) return null;
		busy = true;
		apiError = '';
		const signal = { done: false };
		if (action !== 'pos') {
			moving = true;
			livePosition = position;
			void trackMotion(signal);
		}
		try {
			const res = await fetch('/api/validation/magnetometer/calibrate', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ spuId: selectedSpuId, action, microns })
			});
			const body = await res.json();
			if (!res.ok) {
				apiError = body.error ?? `Request failed (${res.status})`;
				return null;
			}
			position = body.position;
			return body.position;
		} catch (e: any) {
			apiError = e?.message ?? 'Network error';
			return null;
		} finally {
			signal.done = true;
			moving = false;
			livePosition = null;
			busy = false;
		}
	}

	async function home() {
		const p = await call('home');
		if (p !== null) {
			homed = true;
			testResult = null;
		}
	}

	async function jog(microns: number) {
		if (!microns) return;
		await call('jog', microns);
	}

	function capture(i: number) {
		if (position === null) return;
		captured[i] = position;
		captured = [...captured];
	}

	function clearCapture(i: number) {
		captured[i] = null;
		captured = [...captured];
	}

	async function testWell(i: number) {
		const target = captured[i] ?? nominal[i];
		testResult = null;
		const p = await call('goto', target);
		if (p !== null) {
			homed = true;
			testResult = { well: i + 1, position: p };
		}
	}

	function resetSession() {
		captured = Array(fw.numWells).fill(null);
		testResult = null;
		homed = false;
		position = null;
		apiError = '';
	}

	function copyText(text: string) {
		navigator.clipboard?.writeText(text);
	}

	function formatDate(date: string | null): string {
		if (!date) return '—';
		return new Date(date).toLocaleString();
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h2 class="tron-text-primary text-2xl font-bold">Magnetometer Stage Calibration</h2>
		<a href="/validation/magnetometer" class="text-sm text-[var(--color-tron-cyan)] hover:underline">
			← Magnetometer Validation
		</a>
	</div>

	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,0,0,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
		</div>
	{/if}
	{#if form?.saved}
		<div class="rounded border border-[var(--color-tron-cyan)] bg-[rgba(0,255,255,0.05)] p-3">
			<p class="text-sm text-[var(--color-tron-cyan)]">Calibration saved (record {form.recordId}).</p>
		</div>
	{/if}
	{#if apiError}
		<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,0,0,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-red)]">{apiError}</p>
		</div>
	{/if}

	<TronCard>
		<div class="p-4 space-y-4">
			<h3 class="tron-text-primary text-lg font-bold">Device</h3>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				Jog the stage until each magnetometer sensor is centered under its well, capture the
				position, then Test to verify the re-homed approach lands in the same spot. Motion is
				always measured from the proximal limit switch; Test re-homes before every move.
				Requires firmware v89+ (stage_control).
			</p>
			<div class="flex items-end gap-4">
				<div>
					<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]" for="spu-select">SPU</label>
					<select
						id="spu-select"
						bind:value={selectedSpuId}
						onchange={resetSession}
						class="tron-input min-w-64"
					>
						<option value="">Select SPU…</option>
						{#each data.spus as spu (spu.id)}
							<option value={spu.id}>{spu.udi} ({spu.status})</option>
						{/each}
					</select>
				</div>
				<TronButton variant="primary" disabled={!selectedSpuId || busy} onclick={home}>
					{busy ? 'Working…' : 'Home stage (zero at limit switch)'}
				</TronButton>
				<TronButton variant="ghost" disabled={busy} onclick={() => call('pos')}>
					Read position
				</TronButton>
			</div>
			<div class="flex items-center gap-6 text-sm">
				<span class="text-[var(--color-tron-text-secondary)]">
					Device: <span class="text-[var(--color-tron-cyan)]">{selectedSpu?.particleDeviceId ?? '—'}</span>
				</span>
				<span class="text-[var(--color-tron-text-secondary)]">
					Stage position:
					{#if moving}
						<span class="font-mono text-lg text-[var(--color-tron-orange)]">
							{livePosition !== null ? `${livePosition.toLocaleString()} µm` : '—'}
						</span>
						<span class="text-xs text-[var(--color-tron-orange)] animate-pulse">● moving</span>
					{:else}
						<span class="font-mono text-lg {homed ? 'text-[var(--color-tron-cyan)]' : 'text-[var(--color-tron-orange)]'}">
							{position !== null ? `${position.toLocaleString()} µm` : '—'}
						</span>
						{#if position !== null && !homed}
							<span class="text-xs text-[var(--color-tron-orange)]">(not homed this session)</span>
						{/if}
					{/if}
				</span>
			</div>
		</div>
	</TronCard>

	<TronCard>
		<div class="p-4 space-y-4">
			<h3 class="tron-text-primary text-lg font-bold">Jog</h3>
			<div class="flex flex-wrap items-center gap-2">
				{#each JOG_STEPS as step (step)}
					<TronButton disabled={!selectedSpuId || busy} onclick={() => jog(step)}>
						{step > 0 ? `+${step}` : step} µm
					</TronButton>
				{/each}
				<div class="ml-4 flex items-center gap-2">
					<input
						type="number"
						bind:value={customJog}
						step="5"
						class="tron-input w-28"
						aria-label="Custom jog microns"
					/>
					<TronButton disabled={!selectedSpuId || busy || !customJog} onclick={() => jog(-Math.abs(customJog))}>−</TronButton>
					<TronButton disabled={!selectedSpuId || busy || !customJog} onclick={() => jog(Math.abs(customJog))}>+</TronButton>
				</div>
			</div>
			<p class="text-xs text-[var(--color-tron-text-secondary)]">
				+ moves away from the limit switch. The motor stays awake between jogs so the stage holds position.
			</p>
		</div>
	</TronCard>

	<TronCard>
		<div class="p-4 space-y-4">
			<div class="flex items-center justify-between">
				<h3 class="tron-text-primary text-lg font-bold">Magnetometer Positions</h3>
				<TronButton variant="ghost" disabled={busy} onclick={resetSession}>Reset session</TronButton>
			</div>
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-[var(--color-tron-border)] text-left text-xs text-[var(--color-tron-text-secondary)]">
						<th class="py-2">Position</th>
						<th>Nominal (µm)</th>
						<th>Captured (µm)</th>
						<th>Δ vs nominal</th>
						<th class="text-right">Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each Array(fw.numWells) as _, i (i)}
						<tr class="border-b border-[var(--color-tron-border)]">
							<td class="py-2 font-bold text-[var(--color-tron-cyan)]">{i + 1}</td>
							<td class="font-mono">{nominal[i].toLocaleString()}</td>
							<td class="font-mono">
								{captured[i] !== null ? captured[i]?.toLocaleString() : '—'}
							</td>
							<td class="font-mono {captured[i] !== null && captured[i] !== nominal[i] ? 'text-[var(--color-tron-orange)]' : ''}">
								{captured[i] !== null ? `${(captured[i]! - nominal[i]) >= 0 ? '+' : ''}${captured[i]! - nominal[i]}` : '—'}
							</td>
							<td class="py-1 text-right">
								<div class="flex justify-end gap-2">
									<TronButton
										disabled={!selectedSpuId || busy || position === null || !homed}
										onclick={() => capture(i)}
									>
										Capture
									</TronButton>
									<TronButton variant="ghost" disabled={!selectedSpuId || busy} onclick={() => testWell(i)}>
										Test
									</TronButton>
									{#if captured[i] !== null}
										<TronButton variant="danger" disabled={busy} onclick={() => clearCapture(i)}>✕</TronButton>
									{/if}
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			{#if testResult}
				<p class="text-sm text-[var(--color-tron-cyan)]">
					Test: re-homed at limit switch, drove to position {testResult.well} — stage reports
					{testResult.position.toLocaleString()} µm. Verify the sensor is centered; if not, jog and re-capture.
				</p>
			{/if}
			<p class="text-xs text-[var(--color-tron-text-secondary)]">
				Capture requires a homed session so every value is referenced to the limit-switch zero.
				Test uses the captured value (or nominal if not yet captured) and always re-homes first.
			</p>
		</div>
	</TronCard>

	{#if allCaptured && wellMove && bcodeLines}
		<TronCard>
			<div class="p-4 space-y-4">
				<h3 class="tron-text-primary text-lg font-bold">Generated Calibration</h3>

				<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
					<div class="space-y-2">
						<div class="flex items-center justify-between">
							<h4 class="text-sm font-bold text-[var(--color-tron-text-secondary)]">
								Magnetometer BCODE (relative moves from mag start {fw.magStart.toLocaleString()} µm)
							</h4>
							<TronButton variant="ghost" onclick={() => copyText(bcodeLines!.join('\n'))}>Copy</TronButton>
						</div>
						<pre class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-3 font-mono text-sm">{bcodeLines.join('\n')}</pre>
					</div>

					<div class="space-y-2">
						<div class="flex items-center justify-between">
							<h4 class="text-sm font-bold text-[var(--color-tron-text-secondary)]">
								Firmware well_move[] (brevitest-firmware.h)
							</h4>
							<TronButton
								variant="ghost"
								onclick={() => copyText(`int well_move[${fw.numWells}] = { ${wellMove!.join(', ')} };`)}
							>
								Copy
							</TronButton>
						</div>
						<pre class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-3 font-mono text-sm">int well_move[{fw.numWells}] = &#123; {wellMove.join(', ')} &#125;;</pre>
						<p class="text-xs text-[var(--color-tron-text-secondary)]">
							Current firmware: int well_move[{fw.numWells}] = &#123; {fw.currentWellMove.join(', ')} &#125;;
						</p>
					</div>
				</div>

				<form
					method="POST"
					action="?/save"
					use:enhance={() => {
						saving = true;
						return async ({ update }) => {
							saving = false;
							await update({ reset: false });
						};
					}}
					class="flex items-end gap-4"
				>
					<input type="hidden" name="spuId" value={selectedSpuId} />
					<input type="hidden" name="positions" value={JSON.stringify(captured)} />
					<div class="flex-1">
						<label class="mb-1 block text-xs text-[var(--color-tron-text-secondary)]" for="cal-notes">Notes</label>
						<input id="cal-notes" name="notes" bind:value={notes} class="tron-input w-full" placeholder="e.g. jig serial, who measured" />
					</div>
					<TronButton type="submit" variant="primary" disabled={saving || !selectedSpuId}>
						{saving ? 'Saving…' : 'Save calibration'}
					</TronButton>
				</form>
			</div>
		</TronCard>
	{/if}

	<TronCard>
		<div class="p-4 space-y-3">
			<h3 class="tron-text-primary text-lg font-bold">Recent Calibrations</h3>
			{#if data.calibrations.length === 0}
				<p class="text-sm text-[var(--color-tron-text-secondary)]">No stage calibrations recorded yet.</p>
			{:else}
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-[var(--color-tron-border)] text-left text-xs text-[var(--color-tron-text-secondary)]">
							<th class="py-2">Date</th>
							<th>SPU</th>
							<th>Positions (µm)</th>
							<th>well_move[]</th>
							<th>By</th>
						</tr>
					</thead>
					<tbody>
						{#each data.calibrations as cal (cal._id)}
							<tr class="border-b border-[var(--color-tron-border)]">
								<td class="py-2">{formatDate(cal.calibrationDate)}</td>
								<td class="font-mono">{cal.results?.spuUdi ?? cal.equipmentId}</td>
								<td class="font-mono">{(cal.results?.positions ?? []).join(', ')}</td>
								<td class="font-mono">{(cal.results?.wellMove ?? []).join(', ')}</td>
								<td>{cal.performedBy?.username ?? '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>
	</TronCard>
</div>
