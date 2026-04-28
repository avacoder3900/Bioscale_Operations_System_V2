<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard } from '$lib/components/ui';

	let { data, form } = $props();
</script>

<div class="mx-auto max-w-3xl space-y-6 p-6">
	<header>
		<h1 class="tron-text-primary text-2xl font-bold">SPU Work Instruction</h1>
		<p class="tron-text-muted text-sm">One canonical work instruction governs every SPU build.</p>
	</header>

	<TronCard>
		{#if data.wi && data.activeVersion}
			<div class="space-y-2">
				<p class="tron-text-muted text-xs uppercase tracking-wide">Active</p>
				<p class="tron-text-primary text-lg font-medium">{data.wi.title}</p>
				<p class="tron-text-muted text-xs">
					rev {data.wi.revision || '-'} · v{data.activeVersion.version} ·
					{data.activeVersion.stepCount} steps · {data.activeVersion.barcodeFieldCount} scan fields
				</p>
				{#if data.wi.effectiveDate}
					<p class="tron-text-muted text-xs">
						Effective {new Date(data.wi.effectiveDate).toLocaleDateString()}
					</p>
				{/if}
			</div>
		{:else}
			<p class="tron-text-muted text-sm">No active SPU work instruction. Upload a .docx to begin.</p>
		{/if}
	</TronCard>

	<TronCard>
		<form method="POST" action="?/upload" enctype="multipart/form-data" use:enhance class="space-y-4">
			<div>
				<label class="tron-text-primary block text-sm font-medium" for="wi-file">Upload (.docx)</label>
				<p class="tron-text-muted text-xs">
					Parser auto-extracts <code>PT-SPU-XXX</code> + <code>qty=X</code> and generates barcode fields. You confirm before induction.
				</p>
			</div>
			<input
				id="wi-file"
				type="file"
				name="file"
				accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
				required
				class="block w-full text-sm"
			/>
			<button
				type="submit"
				class="rounded-lg bg-[var(--color-tron-cyan)] px-4 py-2 font-semibold text-black hover:opacity-90"
			>
				Upload &amp; Parse
			</button>
			{#if (form as any)?.error}
				<div class="rounded-lg border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
					<p class="text-sm text-[var(--color-tron-red)]">{(form as any).error}</p>
				</div>
			{/if}
		</form>

		{#if data.activeVersion}
			<div class="mt-4 border-t border-white/10 pt-4">
				<a
					href="/spu/work-instruction/review/{data.activeVersion.id}?wi={data.wi?.id}"
					class="inline-block rounded-lg border border-[var(--color-tron-cyan)] px-4 py-2 text-sm text-[var(--color-tron-cyan)] hover:bg-[rgba(0,229,255,0.1)]"
				>
					Edit Active Version
				</a>
			</div>
		{/if}
	</TronCard>

	{#if data.draftVersions.length > 0}
		<TronCard>
			<p class="tron-text-muted mb-3 text-xs uppercase tracking-wide">Other versions</p>
			<ul class="space-y-2 text-sm">
				{#each data.draftVersions as v}
					<li class="flex items-center justify-between">
						<span class="tron-text-primary">
							v{v.version} · {v.stepCount} steps
							{#if v.discarded}
								<span class="ml-2 text-[var(--color-tron-red)]">(discarded)</span>
							{/if}
						</span>
						{#if !v.discarded}
							<a
								href="/spu/work-instruction/review/{v.id}?wi={data.wi?.id}"
								class="text-xs text-[var(--color-tron-cyan)] hover:underline"
							>
								Review
							</a>
						{/if}
					</li>
				{/each}
			</ul>
		</TronCard>
	{/if}

	<p class="tron-text-muted text-center text-xs">Parser v{data.parserVersion}</p>
</div>
