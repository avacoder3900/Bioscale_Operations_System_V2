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

	// Manual entry: for a network the scan did not list (hidden, out of range right now, or the
	// unit is about to be moved). Values are Device OS WLanSecurityType, as in the scan.
	const MANUAL_SECURITY = [
		{ value: 3, label: 'WPA2' },
		{ value: 6, label: 'WPA3' },
		{ value: 2, label: 'WPA' },
		{ value: 1, label: 'WEP' },
		{ value: 0, label: 'Open' }
	];
	let manual = $state(false);
	let manualSsid = $state('');
	let manualSecurity = $state(3);

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
		closeManual();
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
		manual = false;
		selected = n;
		password = '';
		showPassword = false;
		message = null;
	}

	function openManual() {
		if (switching) return;
		selected = null;
		manual = true;
		manualSsid = '';
		manualSecurity = 3;
		password = '';
		showPassword = false;
		message = null;
	}

	function closeManual() {
		manual = false;
		manualSsid = '';
		password = '';
	}

	// A typed name that matches a scanned network takes that network's security type.
	function onManualSsidInput() {
		const hit = networks.find((n) => n.ssid === manualSsid);
		if (hit && hit.supported) manualSecurity = hit.security;
	}

	const passwordOk = (security: number) =>
		security === 0 ? true : password.length >= (security >= 2 ? 8 : 1);

	let canConfirm = $derived(!!selected && !switching && passwordOk(selected.security));

	let manualSsidBytes = $derived(new TextEncoder().encode(manualSsid).length);
	let canConfirmManual = $derived(
		manual &&
			!switching &&
			manualSsid.length > 0 &&
			manualSsidBytes <= 32 &&
			!manualSsid.includes(':::') &&
			passwordOk(manualSecurity)
	);

	function connectManual() {
		const label = MANUAL_SECURITY.find((s) => s.value === manualSecurity)?.label ?? String(manualSecurity);
		connect({
			ssid: manualSsid,
			rssi: 0,
			security: manualSecurity,
			securityLabel: label,
			channel: 0,
			supported: true
		});
	}

	async function connect(target: Network) {
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
					closeManual();
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
		<div class="ml-auto flex gap-2">
			<TronButton
				type="button"
				onclick={openManual}
				disabled={scanning || switching || online === false || supported === false}
				style="min-height: 38px;"
			>
				Enter Network Manually
			</TronButton>
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
				if (canConfirm && selected) connect(selected);
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

	{#if manual}
		<form
			class="mt-3 flex flex-wrap items-center gap-3"
			onsubmit={(e) => {
				e.preventDefault();
				if (canConfirmManual) connectManual();
			}}
		>
			<input
				type="text"
				class="tron-input"
				placeholder="Network Name (SSID)"
				autocomplete="off"
				spellcheck="false"
				maxlength="32"
				bind:value={manualSsid}
				oninput={onManualSsidInput}
				disabled={switching}
				style="min-height: 38px;"
			/>
			<select class="tron-input" bind:value={manualSecurity} disabled={switching} style="min-height: 38px;">
				{#each MANUAL_SECURITY as s (s.value)}
					<option value={s.value}>{s.label}</option>
				{/each}
			</select>
			{#if manualSecurity !== 0}
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
			<TronButton type="submit" variant="primary" disabled={!canConfirmManual} style="min-height: 38px;">
				{switching ? 'Connecting…' : 'Are you sure you want to connect?'}
			</TronButton>
			<TronButton type="button" onclick={closeManual} disabled={switching} style="min-height: 38px;">
				Cancel
			</TronButton>
		</form>
		<p class="tron-text-muted mt-1 text-xs">
			Name and password are case-sensitive. This replaces the SPU's saved Wi-Fi networks; if the name or password is
			wrong the SPU stays on cellular and can be retried.
		</p>
		{#if manualSsid !== manualSsid.trim()}
			<p class="mt-1 text-xs" style="color: {toneColor.warn};">⚠ Network name starts or ends with a space.</p>
		{/if}
	{/if}

	{#if message}
		<p class="mt-2 text-xs" style="color: {toneColor[message.tone]};">{message.text}</p>
	{/if}
</TronCard>
