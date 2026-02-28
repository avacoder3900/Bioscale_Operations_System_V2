<script lang="ts">
	import { enhance } from '$app/forms';
	import { TronCard, TronButton, TronBadge } from '$lib/components/ui';

	let { data, form } = $props();

	let saving = $state(false);
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<a
				href="/spu/bom/settings"
				class="tron-text-muted mb-2 inline-flex items-center gap-1 text-sm hover:text-[var(--color-tron-cyan)]"
			>
				<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M15 19l-7-7 7-7"
					/>
				</svg>
				Back to Settings
			</a>
			<h2 class="tron-text-primary font-mono text-2xl font-bold">Column Mapping</h2>
			<p class="tron-text-muted">Configure how Excel columns map to BOM fields</p>
		</div>
	</div>

	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,51,102,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
		</div>
	{/if}

	{#if form?.success}
		<div class="rounded border border-[var(--color-tron-green)] bg-[rgba(0,255,136,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-green)]">{form.message}</p>
		</div>
	{/if}

	{#if !data.isConnected}
		<TronCard>
			<div class="py-8 text-center">
				<p class="tron-text-muted">
					Box.com is not connected. Please connect first to configure column mapping.
				</p>
				<a href="/spu/bom/settings" class="mt-4 inline-block">
					<TronButton variant="primary">Go to Settings</TronButton>
				</a>
			</div>
		</TronCard>
	{:else if !data.hasFile}
		<TronCard>
			<div class="py-8 text-center">
				<p class="tron-text-muted">BOM file not found in Box.com. Please ensure the file exists.</p>
			</div>
		</TronCard>
	{:else}
		{#if data.previewError}
			<div class="rounded border border-[var(--color-tron-yellow)] bg-[rgba(255,204,0,0.1)] p-3">
				<p class="text-sm text-[var(--color-tron-yellow)]">Preview error: {data.previewError}</p>
			</div>
		{/if}

		<!-- File Preview -->
		{#if data.preview}
			<TronCard>
				<h3 class="tron-text-primary mb-4 text-lg font-medium">File Preview</h3>
				<div class="overflow-x-auto">
					<table class="min-w-full text-sm">
						<thead>
							<tr class="border-b border-[var(--color-tron-border)]">
								<th class="tron-text-muted px-2 py-1 text-left">Row</th>
								{#each data.preview.headers as header, i}
									<th class="tron-text-primary px-2 py-1 text-left">
										<div class="font-mono text-xs text-[var(--color-tron-cyan)]">
											{String.fromCharCode(65 + i)}
										</div>
										{header || '(empty)'}
									</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each data.preview.rows as row, rowIndex}
								<tr class="border-b border-[var(--color-tron-border)]">
									<td class="tron-text-muted px-2 py-1">{rowIndex + 2}</td>
									{#each row as cell}
										<td class="tron-text-primary max-w-[150px] truncate px-2 py-1">{cell || '—'}</td
										>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</TronCard>
		{/if}

		<!-- Mapping Form -->
		<TronCard>
			<h3 class="tron-text-primary mb-4 text-lg font-medium">Field Mapping</h3>
			<form
				method="POST"
				action="?/saveMapping"
				use:enhance={() => {
					saving = true;
					return async ({ update }) => {
						saving = false;
						await update();
					};
				}}
				class="space-y-6"
			>
				<!-- Settings -->
				<div class="grid gap-4 sm:grid-cols-2">
					<div>
						<label for="headerRow" class="tron-text-muted mb-1 block text-sm"
							>Header Row Number</label
						>
						<input
							type="number"
							id="headerRow"
							name="headerRow"
							min="1"
							value={data.mapping?.headerRow ?? 1}
							class="tron-input w-full"
						/>
						<p class="tron-text-muted mt-1 text-xs">Which row contains the column headers?</p>
					</div>
					{#if data.preview?.sheetNames && data.preview.sheetNames.length > 1}
						<div>
							<label for="sheetName" class="tron-text-muted mb-1 block text-sm">Sheet Name</label>
							<select id="sheetName" name="sheetName" class="tron-input w-full">
								{#each data.preview.sheetNames as sheet}
									<option value={sheet} selected={sheet === data.mapping?.sheetName}>{sheet}</option
									>
								{/each}
							</select>
						</div>
					{/if}
				</div>

				<!-- Column Mappings -->
				<div class="space-y-4">
					<p class="tron-text-muted text-sm">
						Enter the Excel column letter (A, B, C, etc.) for each BOM field:
					</p>

					<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
						{#each data.bomFields as field}
							<div>
								<label
									for="column_{field.key}"
									class="tron-text-muted mb-1 flex items-center gap-2 text-sm"
								>
									{field.label}
									{#if field.required}
										<TronBadge variant="warning">Required</TronBadge>
									{/if}
								</label>
								<input
									type="text"
									id="column_{field.key}"
									name="column_{field.key}"
									placeholder="e.g. A"
									value={data.mapping?.columnMappings[field.key] ?? ''}
									class="tron-input w-full font-mono uppercase"
									maxlength="3"
								/>
							</div>
						{/each}
					</div>
				</div>

				<div class="flex justify-end gap-2 pt-4">
					<a href="/spu/bom/settings">
						<TronButton type="button" variant="default">Cancel</TronButton>
					</a>
					<TronButton type="submit" variant="primary" disabled={saving}>
						{saving ? 'Saving...' : 'Save Mapping'}
					</TronButton>
				</div>
			</form>
		</TronCard>
	{/if}
</div>
