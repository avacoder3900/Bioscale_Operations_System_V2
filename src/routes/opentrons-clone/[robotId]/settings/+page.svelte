<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	let { data, form } = $props();

	function driftSeconds(iso: string | null): number | null {
		if (!iso) return null;
		return Math.abs(Math.round((Date.now() - new Date(iso).getTime()) / 1000));
	}

	const drift = driftSeconds(data.systemTime);
</script>

<div class="mb-4">
	<a href={`/opentrons-clone/${data.robot._id}`} class="text-sm text-blue-600 hover:underline">← {data.robot.name}</a>
	<h2 class="text-xl font-semibold mt-1">Settings</h2>
</div>

{#if form?.error}
	<div class="bg-red-50 border border-red-300 text-red-900 rounded p-2 mb-3 text-sm">{form.error}</div>
{:else if form?.success}
	<div class="bg-green-50 border border-green-300 text-green-900 rounded p-2 mb-3 text-sm">{form.message ?? 'OK'}</div>
{/if}

{#if !data.online}
	<div class="bg-red-50 border border-red-300 text-red-900 rounded p-2 mb-3 text-sm">Robot offline.</div>
{/if}

<section class="bg-white border rounded-lg p-4 mb-4">
	<h3 class="font-semibold mb-2">Networking</h3>
	{#if !data.networking}
		<p class="text-sm text-gray-500">No networking data.</p>
	{:else}
		<dl class="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
			<div><dt class="text-gray-400 text-xs">Status</dt><dd>{data.networking.status}</dd></div>
			{#each Object.entries(data.networking.interfaces ?? {}) as [iface, info]}
				{@const i = info as any}
				<div class="border rounded p-2 text-xs">
					<div class="font-semibold">{iface} <span class="text-gray-400">({i.type})</span></div>
					<div>IP: <span class="font-mono">{i.ipAddress ?? '—'}</span></div>
					<div>MAC: <span class="font-mono">{i.macAddress ?? '—'}</span></div>
					<div>Gateway: <span class="font-mono">{i.gatewayAddress ?? '—'}</span></div>
					<div>State: {i.state}</div>
				</div>
			{/each}
		</dl>
	{/if}
</section>

<section class="bg-white border rounded-lg p-4 mb-4">
	<h3 class="font-semibold mb-2">System clock</h3>
	<dl class="grid grid-cols-1 md:grid-cols-3 gap-2 text-sm mb-3">
		<div><dt class="text-gray-400 text-xs">Robot time</dt><dd class="font-mono">{data.systemTime ?? '—'}</dd></div>
		<div><dt class="text-gray-400 text-xs">BIMS time</dt><dd class="font-mono">{new Date().toISOString()}</dd></div>
		<div><dt class="text-gray-400 text-xs">Drift</dt><dd class={drift && drift > 60 ? 'text-amber-700' : ''}>{drift ?? '—'} s</dd></div>
	</dl>
	<form method="POST" action="?/systemTime" use:enhance={() => async ({ result }) => { if (result.type === 'success') await invalidateAll(); }} class="flex items-center gap-2">
		<input type="hidden" name="iso" value={new Date().toISOString()} />
		<button type="submit" disabled={!data.online} class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-sm rounded disabled:opacity-50">
			Sync robot clock to BIMS time
		</button>
	</form>
</section>

<section class="bg-white border rounded-lg p-4 mb-4">
	<h3 class="font-semibold mb-2">Error recovery</h3>
	<p class="text-sm text-gray-600 mb-2">
		When enabled, the robot pauses on recoverable errors and waits for an operator's decision. When disabled,
		recoverable errors become fatal.
	</p>
	{#if data.errorRecoveryEnabled === null}
		<p class="text-sm text-gray-500">Unavailable.</p>
	{:else}
		<form method="POST" action="?/errorRecovery" use:enhance={() => async ({ result }) => { if (result.type === 'success') await invalidateAll(); }}>
			<input type="hidden" name="enabled" value={data.errorRecoveryEnabled ? 'false' : 'true'} />
			<button
				type="submit"
				disabled={!data.online}
				class="px-3 py-1.5 {data.errorRecoveryEnabled ? 'bg-green-100 hover:bg-green-200' : 'bg-gray-100 hover:bg-gray-200'} text-sm rounded disabled:opacity-50"
			>
				{data.errorRecoveryEnabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
			</button>
		</form>
	{/if}
</section>

<section class="bg-white border rounded-lg p-4 mb-4">
	<h3 class="font-semibold mb-2">Feature flags ({data.settings.length})</h3>
	{#if data.settings.length === 0}
		<p class="text-sm text-gray-500">No settings reported.</p>
	{:else}
		<table class="w-full text-xs">
			<thead class="text-gray-400 text-left">
				<tr><th class="py-1">Setting</th><th>Value</th><th class="text-right">Toggle</th></tr>
			</thead>
			<tbody>
				{#each data.settings as s (s.id)}
					<tr class="border-t">
						<td class="py-2 pr-2">
							<div class="font-medium">{s.title ?? s.id}</div>
							<div class="text-gray-500">{s.description ?? ''}</div>
							{#if s.restart_required}<div class="text-amber-600 text-[10px]">restart required</div>{/if}
						</td>
						<td class="text-xs">{s.value === null ? 'unset' : s.value ? 'on' : 'off'}</td>
						<td class="text-right">
							<form
								method="POST"
								action="?/updateSetting"
								use:enhance={() => async ({ result }) => { if (result.type === 'success') await invalidateAll(); }}
								class="inline"
							>
								<input type="hidden" name="id" value={s.id} />
								<input type="hidden" name="value" value={s.value ? 'false' : 'true'} />
								<button type="submit" disabled={!data.online} class="px-2 py-0.5 bg-gray-100 hover:bg-gray-200 rounded text-xs disabled:opacity-50">
									{s.value ? 'Disable' : 'Enable'}
								</button>
							</form>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>

<section class="bg-white border rounded-lg p-4">
	<h3 class="font-semibold mb-2 text-red-700">Reset settings</h3>
	<p class="text-sm text-gray-600 mb-2">
		Resets the selected categories to their factory defaults. Cannot be undone.
	</p>
	<form method="POST" action="?/resetSettings" use:enhance>
		<div class="grid grid-cols-1 md:grid-cols-2 gap-2 mb-3 text-sm">
			{#each data.resetOptions as opt (opt.id)}
				<label class="flex items-start gap-2 text-xs border rounded p-2">
					<input type="checkbox" name="category" value={opt.id} class="mt-0.5" />
					<span>
						<span class="font-medium">{opt.name}</span>
						<span class="block text-gray-500">{opt.description}</span>
					</span>
				</label>
			{/each}
		</div>
		<button
			type="submit"
			disabled={!data.online}
			class="px-3 py-1.5 bg-red-600 text-white text-sm rounded hover:bg-red-700 disabled:opacity-50"
			onclick={(e) => {
				if (!confirm('Reset the selected settings? This cannot be undone.')) e.preventDefault();
			}}
		>
			Reset selected
		</button>
	</form>
</section>
