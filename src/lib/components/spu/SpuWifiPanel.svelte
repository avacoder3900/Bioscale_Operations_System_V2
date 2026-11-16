<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { TronCard, TronBadge, TronButton } from '$lib/components/ui';

	interface Props {
		spuId: string;
	}
	let { spuId }: Props = $props();

	interface Network {
		ssid: string;
		rssi: number;
		security: number;
		securityLabel: string;
		channel: number;
		supported: boolean;
	}
	interface Status {
		ready: boolean;
		ssid: string | null;
		rssi: number | null;
		cloud: boolean;
		cellular: boolean;
		radioOn: boolean;
		switchState: string;
		switchSeq: number;
		target: string | null;
		saved: string[];
	}

	const api = () => `/api/spu/${spuId}/wifi`;

	let online = $state<boolean | null>(null);
	let supported = $state<boolean | null>(null);
	let status = $state<Status | null>(null);
	let networks = $state<Network[]>([]);
	let truncated = $state(false);

	let scanning = $state(false);
	let selected = $state<Network | null>(null);
	let password = $state('');
	let showPassword = $state(false);
	let switching = $state(false);
	let message = $state<{ text: string; tone: 'ok' | 'warn' | 'err' | 'info' } | null>(null);

	let destroyed = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	onDestroy(() => {
		destroyed = true;
		if (timer) clearTimeout(timer);
	});

	const wait = (ms: number) =>
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, ms);
		});

	async function fetchState() {
		const res = await fetch(api());
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const j = await res.json();
		online = j.online;
		if (j.supported !== null) supported = j.supported;
		if (j.status) status = j.status;
		return j;
	}

	onMount(() => {
		fetchState().catch(() => {});
	});

	async function post(body: Record<string, unknown>) {
		const res = await fetch(api(), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		const j = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(j.error ?? j.message ?? `HTTP ${res.status}`);
		return j;
	}

	async function scan() {
		scanning = true;
		message = { text: 'Scanning…', tone: 'info' };
		selected = null;
		password = '';
		try {
			const { seq } = await post({ action: 'scan' });
			const deadline = Date.now() + 30_000;
			while (!destroyed && Date.now() < deadline) {
				await wait(2000);
				const j = await fetchState().catch(() => null);
				if (j?.scan && j.scan.seq >= seq) {
					if (j.scan.error) throw new Error(`Scan failed: ${j.scan.error}`);
					networks = j.scan.networks;
					truncated = j.scan.truncated;
					message = networks.length ? null : { text: 'No Networks Found', tone: 'warn' };
					return;
				}
			}
			throw new Error('Scan timed out');
		} catch (e) {
			message = { text: e instanceof Error ? e.message : String(e), tone: 'err' };
		} finally {
			scanning = false;
		}
	}

	function choose(n: Network) {
		if (!n.supported || switching) return;
		selected = n;
		password = '';
		showPassword = false;
		message = null;
	}

	let canConfirm = $derived(
		!!selected && !switching && (selected.security === 0 ? true : password.length >= (selected.security >= 2 ? 8 : 1))
	);

	async function connect() {
		if (!selected) return;
		const target = selected;
		switching = true;
		message = { text: `Switching To ${target.ssid}…`, tone: 'info' };
		try {
			const { seq } = await post({
				action: 'connect',
				ssid: target.ssid,
				password: target.security === 0 ? '' : password,
				security: target.security
			});
			password = '';
			if (seq == null) {
				message = { text: `Sent To ${target.ssid}`, tone: 'ok' };
				return;
			}
			const deadline = Date.now() + 120_000;
			while (!destroyed && Date.now() < deadline) {
				await wait(3000);
				const j = await fetchState().catch(() => null);
				if (!j || !j.online) {
					message = { text: `Switching To ${target.ssid}… SPU Reconnecting`, tone: 'info' };
					continue;
				}
				const s: Status | null = j.status;
				if (!s || s.switchSeq < seq) continue;
				if (s.switchState === 'joined') {
					message = { text: `Connected To ${target.ssid}`, tone: 'ok' };
					selected = null;
					return;
				}
				if (s.switchState === 'joined_other') {
					message = { text: `⚠ SPU Joined ${s.ssid ?? 'Another Network'} Instead Of ${target.ssid}`, tone: 'warn' };
					return;
				}
				if (s.switchState === 'failed') {
					message = { text: `⚠ Could Not Join ${target.ssid}`, tone: 'err' };
					return;
				}
			}
			message = { text: `⚠ No Confirmation From SPU`, tone: 'warn' };
		} catch (e) {
			message = { text: e instanceof Error ? e.message : String(e), tone: 'err' };
		} finally {
			switching = false;
		}
	}

	function bars(rssi: number) {
		if (rssi >= -55) return 4;
		if (rssi >= -67) return 3;
		if (rssi >= -78) return 2;
		return 1;
	}

	const toneColor = {
		ok: 'var(--color-tron-green)',
		warn: 'var(--color-tron-orange, #f97316)',
		err: 'var(--color-tron-red, #ef4444)',
		info: 'var(--color-tron-text-secondary)'
	};
</script>

<TronCard>
	<div class="flex flex-wrap items-center gap-3">
		<span class="tron-text-muted text-xs font-medium uppercase">Wi-Fi:</span>
		{#if online === false}
			<TronBadge variant="neutral">SPU Offline</TronBadge>
		{:else if supported === false}
			<TronBadge variant="warning">Needs Firmware v109</TronBadge>
		{:else if status}
			<TronBadge variant={status.ready ? 'info' : 'neutral'}>
				{status.ready ? `${status.ssid}${status.rssi != null ? ` · ${status.rssi} dBm` : ''}` : 'Not Connected'}
			</TronBadge>
			<span class="tron-text-muted text-xs">Cellular: {status.cellular ? 'Connected' : 'Off'}</span>
			{#if status.saved.length}
				<span class="tron-text-muted text-xs">Saved: {status.saved.join(', ')}</span>
			{/if}
		{/if}
		<div class="ml-auto">
			<TronButton
				type="button"
				variant="primary"
				onclick={scan}
				disabled={scanning || switching || online === false || supported === false}
				style="min-height: 38px;"
			>
				{scanning ? 'Scanning…' : 'Scan For Networks'}
			</TronButton>
		</div>
	</div>

	{#if networks.length}
		<ul class="mt-3 divide-y rounded border" style="border-color: var(--color-tron-border);">
			{#each networks as n (n.ssid)}
				<li>
					<button
						type="button"
						class="flex w-full items-center gap-3 px-3 py-2 text-left text-sm"
						style="background: {selected?.ssid === n.ssid ? 'rgba(0,255,255,0.08)' : 'transparent'}; opacity: {n.supported ? 1 : 0.45}; cursor: {n.supported && !switching ? 'pointer' : 'not-allowed'};"
						disabled={!n.supported || switching}
						onclick={() => choose(n)}
					>
						<span class="font-mono tracking-tighter" style="color: var(--color-tron-cyan);" aria-label="{n.rssi} dBm">
							{'▮'.repeat(bars(n.rssi))}<span class="tron-text-muted">{'▯'.repeat(4 - bars(n.rssi))}</span>
						</span>
						<span class="tron-text-primary flex-1 truncate">{n.ssid}</span>
						{#if status?.ready && status.ssid === n.ssid}
							<TronBadge variant="info">Current</TronBadge>
						{/if}
						<span class="tron-text-muted text-xs">{n.securityLabel}</span>
						<span class="tron-text-muted w-16 text-right font-mono text-xs">{n.rssi} dBm</span>
					</button>
				</li>
			{/each}
		</ul>
		{#if truncated}
			<p class="tron-text-muted mt-1 text-xs">Showing Strongest {networks.length}</p>
		{/if}
	{/if}

	{#if selected}
		<form
			class="mt-3 flex flex-wrap items-center gap-3"
			onsubmit={(e) => {
				e.preventDefault();
				if (canConfirm) connect();
			}}
		>
			<span class="tron-text-primary text-sm font-medium">{selected.ssid}</span>
			{#if selected.security !== 0}
				<input
					type={showPassword ? 'text' : 'password'}
					class="tron-input flex-1"
					placeholder="Password"
					autocomplete="off"
					maxlength="64"
					bind:value={password}
					disabled={switching}
					style="min-height: 38px;"
				/>
				<TronButton type="button" onclick={() => (showPassword = !showPassword)} disabled={switching} style="min-height: 38px;">
					{showPassword ? 'Hide' : 'Show'}
				</TronButton>
			{/if}
			<TronButton type="submit" variant="primary" disabled={!canConfirm} style="min-height: 38px;">
				{switching ? 'Connecting…' : 'Are you sure you want to connect?'}
			</TronButton>
			<TronButton type="button" onclick={() => { selected = null; password = ''; }} disabled={switching} style="min-height: 38px;">
				Cancel
			</TronButton>
		</form>
	{/if}

	{#if message}
		<p class="mt-2 text-xs" style="color: {toneColor[message.tone]};">{message.text}</p>
	{/if}
</TronCard>
