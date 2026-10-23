<script lang="ts">
	/**
	 * Arm Pi temperature / throttle chip for the camera card header, so every
	 * Robot Arm tab shows it even with the picture collapsed.
	 *
	 * Shows the SoC temperature always (muted when fine) and turns it into a
	 * warning when the Raspberry Pi firmware is holding the chip back: amber
	 * for "hot" (≥ 78 °C, or throttled / clock capped right now), red and
	 * pulsing for "critical" (≥ 84 °C, or the firmware's soft temperature
	 * limit is active — it is already cutting the clock to cool down). Hover
	 * for the clock, the service's CPU use and what has happened since boot.
	 *
	 * Next to it, the Wi-Fi the Pi is on (SSID and signal) from the same
	 * response: muted when it is the expected network (ARM_WIFI_EXPECTED_SSID
	 * in the Pi's .env), amber when it has drifted onto another network, red
	 * when it is not associated at all. Added 2026-10-22 after the Pi quietly
	 * switched between its saved networks and BIMS could only say "unreachable".
	 *
	 * Below those, on its own line, each follower servo's temperature from the
	 * same poll (GET /arm/health on the Pi): one number per servo in id order,
	 * amber at the Pi's warm threshold (48 °C), red at hot (55 °C; the STS3215
	 * derates above ~60). Hover a number for that servo's load, voltage,
	 * torque and flags. Added 2026-10-23 so motor heat is visible next to the
	 * Pi's on every tab.
	 *
	 * Polls /api/robot-arm/thermal every 30 s while the tab is visible, and
	 * once right away (the layout load deliberately does not read the servo
	 * bus, so the servo row has nothing until the first poll); the server side
	 * logs Pi episodes to device_events. The Pi rows render nothing when the
	 * Pi is unreachable or the thermal route is not installed on it; the servo
	 * row renders nothing while the follower is disconnected.
	 */
	import { onMount } from 'svelte';
	import type { ArmHealth, ArmThermal } from '$lib/server/robot-arm-client';

	interface Props {
		initial: ArmThermal | null;
		armReachable: boolean;
	}
	let { initial, armReachable }: Props = $props();

	const POLL_MS = 30_000;

	let thermal = $state<ArmThermal | null>(initial);
	let installed = $state(initial !== null);
	let failures = $state(0);
	let servos = $state<ArmHealth | null>(null);
	let servoFailures = $state(0);

	const FLAG_TEXT: Record<string, string> = {
		throttled: 'throttled',
		freq_capped: 'clock capped',
		soft_temp_limit: 'soft temp limit',
		under_voltage: 'under-voltage'
	};
	const BOOT_TEXT: Record<string, string> = {
		throttled_occurred: 'throttled',
		freq_capped_occurred: 'clock capped',
		soft_temp_limit_occurred: 'soft temp limit',
		under_voltage_occurred: 'under-voltage'
	};

	let level = $derived(thermal?.level ?? 'ok');
	let color = $derived(level === 'critical' ? '#ef4444' : level === 'hot' ? '#f59e0b' : level === 'warm' ? '#fbbf24' : 'var(--color-tron-text-secondary)');
	let flags = $derived((thermal?.now ?? []).map((f) => FLAG_TEXT[f] ?? f));
	let label = $derived.by(() => {
		if (!thermal) return '';
		const t = thermal.temp_c != null ? `${Math.round(thermal.temp_c)} °C` : '?';
		if (flags.length) return `Pi ${t} · ${flags.join(', ')}`;
		if (level === 'critical') return `Pi ${t} · critical`;
		if (level === 'hot') return `Pi ${t} · hot`;
		return `Pi ${t}`;
	});
	let title = $derived.by(() => {
		if (!thermal) return '';
		const lines = [
			`Arm Pi SoC ${thermal.temp_c ?? '?'} °C (${level}). Warm ≥ ${thermal.thresholds.warm_c}, hot ≥ ${thermal.thresholds.hot_c}, critical ≥ ${thermal.thresholds.critical_c} °C; the firmware throttles from 80 °C and hard-limits at 85.`,
			thermal.clock_mhz != null ? `Clock ${thermal.clock_mhz}${thermal.clock_max_mhz ? ` / ${thermal.clock_max_mhz}` : ''} MHz` : null,
			thermal.service_cpu_pct != null ? `robot-arm service CPU ${thermal.service_cpu_pct}% (of one core; >100 = several threads)` : null,
			thermal.load_1m != null ? `Load (1 min) ${thermal.load_1m}` : null,
			thermal.fan_rpm != null ? `Fan ${thermal.fan_rpm} rpm` : 'No fan detected',
			flags.length ? `Right now: ${flags.join(', ')}` : 'Not throttled right now',
			thermal.since_boot.length ? `Since boot: ${thermal.since_boot.map((f) => BOOT_TEXT[f] ?? f).join(', ')}` : 'No throttling since boot',
			level === 'critical' || level === 'hot' ? 'Cool it down: lower the camera fps/resolution on the Pi (hardware.yaml), stop live tag detection, or add a fan.' : null
		];
		return lines.filter(Boolean).join('\n');
	});

	let net = $derived(thermal?.network ?? null);
	let netState = $derived.by<'ok' | 'wrong' | 'none' | 'unknown'>(() => {
		if (!net) return 'unknown';
		if (!net.ssid) return net.source?.startsWith('unavailable') ? 'unknown' : 'none';
		if (net.expected_ssid && net.ssid !== net.expected_ssid) return 'wrong';
		return 'ok';
	});
	let netColor = $derived(
		netState === 'none' ? '#ef4444' : netState === 'wrong' ? '#f59e0b' : 'var(--color-tron-text-secondary)'
	);
	let netLabel = $derived.by(() => {
		if (!net) return '';
		if (netState === 'unknown') return 'Wi-Fi ?';
		if (netState === 'none') return 'No Wi-Fi';
		const sig = net.signal_pct != null ? ` · ${net.signal_pct}%` : '';
		return `Wi-Fi ${net.ssid}${sig}`;
	});
	let netTitle = $derived.by(() => {
		if (!net) return '';
		const lines = [
			netState === 'wrong'
				? `Arm Pi is on "${net.ssid}" but should be on "${net.expected_ssid}". It only re-picks a network when it reconnects: on the Pi, nmcli con up <profile> (or reboot) once that network is in range.`
				: netState === 'none'
					? `Arm Pi ${net.iface} is not associated with any Wi-Fi.`
					: netState === 'unknown'
						? `Could not read the Pi's Wi-Fi (${net.source ?? 'no nmcli output'}).`
						: `Arm Pi Wi-Fi ${net.ssid}${net.expected_ssid ? ' (expected)' : ''}.`,
			net.connection ? `Profile ${net.connection}` : null,
			net.signal_pct != null ? `Signal ${net.signal_pct}%${net.freq_mhz ? ` at ${(net.freq_mhz / 1000).toFixed(1)} GHz` : ''}` : null,
			net.ip ? `LAN IP ${net.ip} on ${net.iface}` : `No IPv4 on ${net.iface}`
		];
		return lines.filter(Boolean).join('\n');
	});

	// Servo temperatures, in servo-id order. Colour per servo against the Pi's
	// own thresholds; the row's border follows the hottest one.
	let joints = $derived([...(servos?.joints ?? [])].sort((a, b) => a.id - b.id));
	let warmC = $derived(servos?.thresholds.temp_warm_c ?? 48);
	let hotC = $derived(servos?.thresholds.temp_hot_c ?? 55);
	function servoColor(t: number): string {
		return t >= hotC ? '#ef4444' : t >= warmC ? '#f59e0b' : 'var(--color-tron-text)';
	}
	let servoLevel = $derived.by<'ok' | 'warm' | 'hot'>(() => {
		const max = Math.max(...joints.map((j) => j.temperature), Number.NEGATIVE_INFINITY);
		return max >= hotC ? 'hot' : max >= warmC ? 'warm' : 'ok';
	});
	let servoRowColor = $derived(servoLevel === 'hot' ? '#ef4444' : servoLevel === 'warm' ? '#f59e0b' : 'var(--color-tron-text-secondary)');
	const JOINT_FLAG_TEXT: Record<string, string> = {
		hot: 'hot',
		warm: 'warm',
		high_load: 'high load',
		undervolt: 'under-voltage',
		overvolt: 'over-voltage',
		torque_off: 'torque off'
	};
	function servoTitle(j: ArmHealth['joints'][number]): string {
		const flags = j.flags.filter((f) => f !== 'torque_off').map((f) => JOINT_FLAG_TEXT[f] ?? f);
		return [
			`Servo ${j.id}: ${j.temperature} °C`,
			`Load ${j.load}, ${j.voltage.toFixed(1)} V, torque ${j.torque ? 'on' : 'off'}`,
			flags.length ? `Flags: ${flags.join(', ')}` : null
		]
			.filter(Boolean)
			.join('\n');
	}
	let servoRowTitle = $derived(
		`Follower servo temperatures, left to right = servo 1 … ${joints.length}. Warm ≥ ${warmC} °C, hot ≥ ${hotC} °C (the STS3215 derates above ~60 °C). Hover a number for that servo's load, voltage and flags.`
	);

	async function poll(): Promise<void> {
		try {
			const res = await fetch('/api/robot-arm/thermal', { cache: 'no-store' });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as {
				thermal: ArmThermal | null;
				installed: boolean;
				error: string | null;
				servos?: ArmHealth | null;
				servosError?: string | null;
			};
			installed = body.installed;
			if (body.thermal) {
				thermal = body.thermal;
				failures = 0;
			} else {
				failures++;
			}
			if (body.servos && body.servos.joints?.length) {
				servos = body.servos;
				servoFailures = 0;
			} else {
				servoFailures++;
			}
		} catch {
			failures++;
			servoFailures++;
		}
		// Three misses in a row: the Pi is off or unreachable; stop showing a stale number.
		if (failures >= 3) thermal = null;
		if (servoFailures >= 3) servos = null;
	}

	onMount(() => {
		if (!armReachable) return;
		const tick = () => {
			if (document.visibilityState === 'visible') void poll();
		};
		// Right away for the servo row (the layout load never reads the servo bus).
		tick();
		const id = setInterval(tick, POLL_MS);
		document.addEventListener('visibilitychange', tick);
		return () => {
			clearInterval(id);
			document.removeEventListener('visibilitychange', tick);
		};
	});
</script>

{#if thermal && installed}
	<!-- Line 2 of the camera header: the Pi's heat, then the Wi-Fi it is on. -->
	<div class="flex flex-wrap items-center gap-1.5">
		<span
			class="shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] leading-tight {level === 'critical' ? 'animate-pulse' : ''}"
			style="color: {color}; border: 1px solid {level === 'ok' ? 'var(--color-tron-border)' : color}; background: {level === 'ok' ? 'transparent' : 'rgba(0,0,0,0.25)'}"
			{title}
			aria-live={level === 'critical' || level === 'hot' ? 'polite' : 'off'}
		>
			{label}
		</span>
		{#if net}
			<span
				class="shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] leading-tight"
				style="color: {netColor}; border: 1px solid {netState === 'ok' || netState === 'unknown' ? 'var(--color-tron-border)' : netColor}; background: {netState === 'ok' || netState === 'unknown' ? 'transparent' : 'rgba(0,0,0,0.25)'}"
				title={netTitle}
				aria-live={netState === 'wrong' || netState === 'none' ? 'polite' : 'off'}
			>
				{netLabel}
			</span>
		{/if}
	</div>
{/if}
{#if joints.length}
	<!-- Line 3: every follower servo's temperature, servo 1 first. -->
	<div class="flex flex-wrap items-center gap-1.5">
		<span
			class="inline-flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-[11px] leading-tight {servoLevel === 'hot' ? 'animate-pulse' : ''}"
			style="color: {servoRowColor}; border: 1px solid {servoLevel === 'ok' ? 'var(--color-tron-border)' : servoRowColor}; background: {servoLevel === 'ok' ? 'transparent' : 'rgba(0,0,0,0.25)'}"
			title={servoRowTitle}
			aria-live={servoLevel === 'hot' ? 'polite' : 'off'}
		>
			<span>Servos</span>
			{#each joints as j (j.id)}
				<span style="color: {servoColor(j.temperature)}" title={servoTitle(j)}>{j.temperature}</span>
			{/each}
			<span>°C</span>
		</span>
	</div>
{/if}
