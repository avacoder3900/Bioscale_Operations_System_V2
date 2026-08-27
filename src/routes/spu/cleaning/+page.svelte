<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import KanbanNav from '$lib/components/kanban/KanbanNav.svelte';

	let { data, form } = $props();

	const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	const MONTH_NAMES = [
		'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'
	];

	let selectedKey = $state<string | null>(null);
	let showAreaModal = $state(false);
	let showTaskModal = $state(false);
	let taskKind = $state<'daily' | 'weekly' | 'monthly'>('weekly');
	let busy = $state(false);

	const monthLabel = $derived(
		`${MONTH_NAMES[Number(data.month.slice(5, 7)) - 1]} ${data.month.slice(0, 4)}`
	);

	const allRows = $derived(Object.values(data.byDay).flat() as any[]);
	const selected = $derived(allRows.find((r) => r.key === selectedKey) ?? null);

	/** Split the flat day list into calendar weeks. */
	const weeks = $derived.by(() => {
		const out: string[][] = [];
		for (let i = 0; i < data.days.length; i += 7) out.push(data.days.slice(i, i + 7));
		return out;
	});

	function dayNum(key: string) {
		return Number(key.slice(8, 10));
	}
	function inMonth(key: string) {
		return key >= data.monthStart && key <= data.monthEnd;
	}
	function fmtDate(key: string) {
		const [y, m, d] = key.split('-').map(Number);
		return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
	}
	function fmtStamp(iso: string | null) {
		if (!iso) return '';
		return new Date(iso).toLocaleString(undefined, {
			month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
		});
	}

	const STATE_STYLE: Record<string, string> = {
		completed: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
		skipped: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/40 line-through',
		overdue: 'bg-red-500/15 text-red-300 border-red-500/50',
		due: 'bg-amber-500/15 text-amber-200 border-amber-500/50',
		upcoming: 'bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-text-secondary)] border-[var(--color-tron-border)]'
	};

	const STATE_LABEL: Record<string, string> = {
		completed: 'Cleaned',
		skipped: 'Skipped',
		overdue: 'Overdue',
		due: 'Due today',
		upcoming: 'Upcoming'
	};

	function navMonth(month: string) {
		const params = new URLSearchParams($page.url.searchParams);
		params.set('month', month);
		goto(`?${params.toString()}`, { keepFocus: true, noScroll: true });
	}

	function setArea(areaId: string) {
		const params = new URLSearchParams($page.url.searchParams);
		if (areaId) params.set('area', areaId);
		else params.delete('area');
		goto(`?${params.toString()}`, { keepFocus: true, noScroll: true });
	}

	const submitting = () => {
		busy = true;
		return async ({ result, update }: any) => {
			await update({ reset: false });
			busy = false;
			// Only dismiss on success -- on a validation failure the user needs to
			// stay put and see what went wrong.
			if (result?.type === 'success') {
				selectedKey = null;
				showAreaModal = false;
				showTaskModal = false;
			}
		};
	};
</script>

<svelte:head><title>Cleaning Calendar | BIMS</title></svelte:head>

<div class="p-4 sm:p-6 space-y-5">
	<!-- Cleaning is reached from the Kanban tab bar (right of Roadmap), so carry
	     that bar through to this page for anyone who can see the board. -->
	{#if data.canAccessKanban}
		<KanbanNav />
	{/if}

	<!-- Header -->
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h1 class="text-2xl font-bold text-[var(--color-tron-text-primary)]">Cleaning Calendar</h1>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				Scheduled cleaning, sign-offs, and who did what.
			</p>
		</div>

		<div class="flex flex-wrap items-center gap-2">
			{#if data.areas.length}
				<select
					class="rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)]"
					value={data.areaFilter}
					onchange={(e) => setArea((e.currentTarget as HTMLSelectElement).value)}
				>
					<option value="">All areas</option>
					{#each data.areas as area (area.id)}
						<option value={area.id}>{area.name}</option>
					{/each}
				</select>
			{/if}

			{#if data.canAdmin}
				<button
					class="rounded-md border border-[var(--color-tron-border)] px-3 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]"
					onclick={() => (showAreaModal = true)}
				>+ Area</button>
				<button
					class="rounded-md bg-[var(--color-tron-cyan)] px-3 py-2 text-sm font-medium text-black hover:opacity-90 disabled:opacity-50"
					disabled={!data.areas.length}
					title={data.areas.length ? '' : 'Create an area first'}
					onclick={() => (showTaskModal = true)}
				>+ Cleaning Task</button>
			{/if}
		</div>
	</div>

	{#if form?.error}
		<div class="rounded-md border border-red-500/50 bg-red-500/10 px-4 py-2 text-sm text-red-300">
			{form.error}
		</div>
	{/if}

	<!-- Stats -->
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-5">
		{#each [
			{ label: 'Due today', value: data.stats.dueToday, tone: 'text-amber-300' },
			{ label: 'Overdue', value: data.stats.overdue, tone: 'text-red-300' },
			{ label: 'Done this month', value: data.stats.completedThisMonth, tone: 'text-emerald-300' },
			{ label: 'Active tasks', value: data.stats.schedules, tone: 'text-[var(--color-tron-text-primary)]' },
			{ label: 'Areas', value: data.stats.areas, tone: 'text-[var(--color-tron-text-primary)]' }
		] as stat (stat.label)}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3">
				<div class="text-2xl font-bold {stat.tone}">{stat.value}</div>
				<div class="text-xs text-[var(--color-tron-text-secondary)]">{stat.label}</div>
			</div>
		{/each}
	</div>

	<!-- Overdue -->
	{#if data.attention.length}
		<div class="rounded-lg border border-red-500/40 bg-red-500/5 p-4">
			<h2 class="mb-2 text-sm font-semibold text-red-300">
				Missed cleanings ({data.attention.length})
			</h2>
			<div class="flex flex-wrap gap-2">
				{#each data.attention as row (row.key)}
					<button
						class="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-left text-xs text-red-200 hover:bg-red-500/20"
						onclick={() => (selectedKey = row.key)}
					>
						<span class="font-medium">{row.title}</span>
						<span class="opacity-70"> · {row.areaName} · {fmtDate(row.dueDate)}</span>
					</button>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Month nav -->
	<div class="flex items-center justify-between gap-2">
		<div class="flex items-center gap-1">
			<button
				class="rounded-md border border-[var(--color-tron-border)] px-3 py-1.5 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]"
				onclick={() => navMonth(data.prevMonth)}
				aria-label="Previous month"
			>‹</button>
			<button
				class="rounded-md border border-[var(--color-tron-border)] px-3 py-1.5 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]"
				onclick={() => navMonth(data.today.slice(0, 7))}
			>Today</button>
			<button
				class="rounded-md border border-[var(--color-tron-border)] px-3 py-1.5 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]"
				onclick={() => navMonth(data.nextMonth)}
				aria-label="Next month"
			>›</button>
		</div>
		<h2 class="text-lg font-semibold text-[var(--color-tron-text-primary)]">{monthLabel}</h2>
		<div class="w-[132px]"></div>
	</div>

	<!-- Calendar -->
	<div class="overflow-hidden rounded-lg border border-[var(--color-tron-border)]">
		<div class="grid grid-cols-7 border-b border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)]">
			{#each DOW as d (d)}
				<div class="px-2 py-2 text-center text-xs font-semibold text-[var(--color-tron-text-secondary)]">{d}</div>
			{/each}
		</div>

		{#each weeks as week, wi (wi)}
			<div class="grid grid-cols-7">
				{#each week as day (day)}
					{@const rows = data.byDay[day] ?? []}
					<div
						class="min-h-[112px] border-b border-r border-[var(--color-tron-border)] p-1.5
							{inMonth(day) ? 'bg-[var(--color-tron-bg-secondary)]' : 'bg-[var(--color-tron-bg-primary)] opacity-50'}
							{day === data.today ? 'ring-1 ring-inset ring-[var(--color-tron-cyan)]' : ''}"
					>
						<div class="mb-1 flex items-center justify-between">
							<span
								class="text-xs font-medium {day === data.today
									? 'text-[var(--color-tron-cyan)]'
									: 'text-[var(--color-tron-text-secondary)]'}"
							>{dayNum(day)}</span>
							{#if rows.length > 2}
								<span class="text-[10px] text-[var(--color-tron-text-secondary)]">{rows.length}</span>
							{/if}
						</div>

						<div class="space-y-1">
							{#each rows as row (row.key)}
								<button
									class="block w-full truncate rounded border px-1.5 py-1 text-left text-[11px] leading-tight {STATE_STYLE[row.state]}"
									onclick={() => (selectedKey = row.key)}
									title="{row.title} — {row.areaName} — {STATE_LABEL[row.state]}"
								>
									<span
										class="mr-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full align-middle"
										style="background:{row.color}"
									></span>{row.title}
								</button>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		{/each}
	</div>

	<!-- Recent activity -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
		<h2 class="mb-3 text-sm font-semibold text-[var(--color-tron-text-primary)]">Recent sign-offs</h2>
		{#if data.recentActivity.length === 0}
			<p class="text-sm text-[var(--color-tron-text-secondary)]">Nothing recorded yet.</p>
		{:else}
			<ul class="space-y-2">
				{#each data.recentActivity as act (act.id)}
					<li class="flex flex-wrap items-baseline gap-x-2 text-sm">
						<span
							class="rounded px-1.5 py-0.5 text-[11px] {act.status === 'skipped'
								? 'bg-zinc-500/15 text-zinc-400'
								: 'bg-emerald-500/15 text-emerald-300'}"
						>{act.status === 'skipped' ? 'Skipped' : 'Cleaned'}</span>
						<span class="font-medium text-[var(--color-tron-text-primary)]">{act.title}</span>
						<span class="text-[var(--color-tron-text-secondary)]">{act.areaName}</span>
						<span class="text-[var(--color-tron-text-secondary)]">by {act.by}</span>
						<span class="ml-auto text-xs text-[var(--color-tron-text-secondary)]">{fmtStamp(act.at)}</span>
						{#if act.notes}
							<span class="w-full text-xs italic text-[var(--color-tron-text-secondary)]">“{act.notes}”</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>

<!-- Occurrence detail -->
{#if selected}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
		role="button"
		tabindex="-1"
		onclick={(e) => { if (e.target === e.currentTarget) selectedKey = null; }}
		onkeydown={(e) => { if (e.key === 'Escape') selectedKey = null; }}
	>
		<div class="w-full max-w-md rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-5">
			<div class="mb-1 flex items-start justify-between gap-3">
				<h3 class="text-lg font-semibold text-[var(--color-tron-text-primary)]">{selected.title}</h3>
				<span class="shrink-0 rounded border px-2 py-0.5 text-xs {STATE_STYLE[selected.state]}">
					{STATE_LABEL[selected.state]}
				</span>
			</div>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				{selected.areaName} · due {fmtDate(selected.dueDate)}
			</p>
			<p class="mt-1 text-xs text-[var(--color-tron-text-secondary)]">
				{selected.cadence}{selected.assignedTo ? ` · assigned to ${selected.assignedTo}` : ''}
			</p>

			{#if selected.instructions}
				<div class="mt-3 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] p-2 text-sm text-[var(--color-tron-text-secondary)] whitespace-pre-wrap">
					{selected.instructions}
				</div>
			{/if}

			{#if selected.record}
				<div class="mt-3 rounded border border-[var(--color-tron-border)] p-2 text-sm">
					<div class="text-[var(--color-tron-text-primary)]">
						{selected.record.status === 'skipped' ? 'Skipped' : 'Cleaned'} by
						<span class="font-medium">
							{selected.record.performedBy || selected.record.completedBy}
						</span>
					</div>
					<div class="text-xs text-[var(--color-tron-text-secondary)]">
						{fmtStamp(selected.record.completedAt)}
						{#if selected.record.performedBy}
							· recorded by {selected.record.completedBy}
						{/if}
					</div>
					{#if selected.record.notes}
						<div class="mt-1 text-xs italic text-[var(--color-tron-text-secondary)]">
							“{selected.record.notes}”
						</div>
					{/if}
				</div>
			{/if}

			{#if data.canWrite}
				{#if selected.record}
					<form method="POST" action="?/undo" use:enhance={submitting} class="mt-4">
						<input type="hidden" name="scheduleId" value={selected.scheduleId} />
						<input type="hidden" name="dueDate" value={selected.dueDate} />
						<button
							type="submit"
							disabled={busy}
							class="w-full rounded-md border border-[var(--color-tron-border)] px-3 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:text-red-300 disabled:opacity-50"
						>Clear this sign-off</button>
					</form>
				{:else if selected.dueDate > data.today}
					<p class="mt-4 text-center text-sm text-[var(--color-tron-text-secondary)]">
						Not due yet — you can sign off on {fmtDate(selected.dueDate)}.
					</p>
				{:else}
					<form method="POST" action="?/complete" use:enhance={submitting} class="mt-4 space-y-3">
						<input type="hidden" name="scheduleId" value={selected.scheduleId} />
						<input type="hidden" name="dueDate" value={selected.dueDate} />
						<label class="block">
							<span class="text-xs text-[var(--color-tron-text-secondary)]">Cleaned by</span>
							<input
								type="text"
								name="performedBy"
								maxlength="80"
								autocomplete="off"
								placeholder={data.currentUsername}
								class="mt-1 w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)]"
							/>
							<span class="mt-1 block text-[11px] text-[var(--color-tron-text-secondary)]">
								Leave blank if you did it. Your account is recorded either way.
							</span>
						</label>
						<textarea
							name="notes"
							rows="2"
							placeholder="Notes (optional)"
							class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)]"
						></textarea>
						<div class="flex gap-2">
							<button
								type="submit"
								name="status"
								value="completed"
								disabled={busy}
								class="flex-1 rounded-md bg-emerald-500 px-3 py-2 text-sm font-medium text-black hover:opacity-90 disabled:opacity-50"
							>Mark cleaned</button>
							<button
								type="submit"
								name="status"
								value="skipped"
								disabled={busy}
								class="rounded-md border border-[var(--color-tron-border)] px-3 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text-primary)] disabled:opacity-50"
							>Skip</button>
						</div>
					</form>
				{/if}
			{/if}

			<button
				class="mt-3 w-full text-center text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-text-primary)]"
				onclick={() => (selectedKey = null)}
			>Close</button>
		</div>
	</div>
{/if}

<!-- New area -->
{#if showAreaModal}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
		<form
			method="POST"
			action="?/createArea"
			use:enhance={submitting}
			class="w-full max-w-md space-y-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-5"
		>
			<h3 class="text-lg font-semibold text-[var(--color-tron-text-primary)]">New cleaning area</h3>
			{#if form?.error}
				<p class="rounded border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-300">{form.error}</p>
			{/if}
			<input
				name="name"
				required
				placeholder="e.g. Wax Room"
				class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)]"
			/>
			<input
				name="description"
				placeholder="Description (optional)"
				class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)]"
			/>
			<label class="flex items-center gap-2 text-sm text-[var(--color-tron-text-secondary)]">
				Colour
				<input name="color" type="color" value="#00d4ff" class="h-8 w-16 rounded border border-[var(--color-tron-border)] bg-transparent" />
			</label>
			<div class="flex gap-2 pt-1">
				<button type="submit" disabled={busy} class="flex-1 rounded-md bg-[var(--color-tron-cyan)] px-3 py-2 text-sm font-medium text-black disabled:opacity-50">Create</button>
				<button type="button" onclick={() => (showAreaModal = false)} class="rounded-md border border-[var(--color-tron-border)] px-3 py-2 text-sm text-[var(--color-tron-text-secondary)]">Cancel</button>
			</div>
		</form>
	</div>
{/if}

<!-- New task -->
{#if showTaskModal}
	<div class="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-4">
		<form
			method="POST"
			action="?/createSchedule"
			use:enhance={submitting}
			class="my-8 w-full max-w-lg space-y-3 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-5"
		>
			<h3 class="text-lg font-semibold text-[var(--color-tron-text-primary)]">New cleaning task</h3>
			{#if form?.error}
				<p class="rounded border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-300">{form.error}</p>
			{/if}

			<input
				name="title"
				required
				placeholder="What needs doing, e.g. Mop floor"
				class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)]"
			/>

			<select
				name="areaId"
				required
				class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)]"
			>
				{#each data.areas as area (area.id)}
					<option value={area.id}>{area.name}</option>
				{/each}
			</select>

			<textarea
				name="instructions"
				rows="2"
				placeholder="Instructions (optional) — what 'done' looks like"
				class="w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)]"
			></textarea>

			<div class="flex flex-wrap items-center gap-2">
				<select
					name="kind"
					bind:value={taskKind}
					class="rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)]"
				>
					<option value="daily">Daily</option>
					<option value="weekly">Weekly</option>
					<option value="monthly">Monthly</option>
				</select>
				<label class="flex items-center gap-1 text-sm text-[var(--color-tron-text-secondary)]">
					every
					<input
						name="interval"
						type="number"
						min="1"
						max="52"
						value="1"
						class="w-16 rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-2 py-2 text-sm text-[var(--color-tron-text-primary)]"
					/>
					{taskKind === 'daily' ? 'day(s)' : taskKind === 'weekly' ? 'week(s)' : 'month(s)'}
				</label>
			</div>

			{#if taskKind === 'weekly'}
				<div class="flex flex-wrap gap-1">
					{#each DOW as d, i (d)}
						<label class="cursor-pointer rounded border border-[var(--color-tron-border)] px-2 py-1 text-xs text-[var(--color-tron-text-secondary)] has-[:checked]:border-[var(--color-tron-cyan)] has-[:checked]:text-[var(--color-tron-cyan)]">
							<input type="checkbox" name="daysOfWeek" value={i} class="sr-only" />
							{d}
						</label>
					{/each}
				</div>
			{:else if taskKind === 'monthly'}
				<label class="flex items-center gap-2 text-sm text-[var(--color-tron-text-secondary)]">
					on day
					<input
						name="dayOfMonth"
						type="number"
						min="1"
						max="31"
						value="1"
						class="w-20 rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-2 py-2 text-sm text-[var(--color-tron-text-primary)]"
					/>
					<span class="text-xs">(clamped to shorter months)</span>
				</label>
			{/if}

			<div class="grid grid-cols-2 gap-2">
				<label class="text-xs text-[var(--color-tron-text-secondary)]">
					Starts
					<input
						name="startDate"
						type="date"
						required
						value={data.today}
						class="mt-1 w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)]"
					/>
				</label>
				<label class="text-xs text-[var(--color-tron-text-secondary)]">
					Ends (optional)
					<input
						name="endDate"
						type="date"
						class="mt-1 w-full rounded-md border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-3 py-2 text-sm text-[var(--color-tron-text-primary)]"
					/>
				</label>
			</div>

			<div class="flex gap-2 pt-1">
				<button type="submit" disabled={busy} class="flex-1 rounded-md bg-[var(--color-tron-cyan)] px-3 py-2 text-sm font-medium text-black disabled:opacity-50">Create task</button>
				<button type="button" onclick={() => (showTaskModal = false)} class="rounded-md border border-[var(--color-tron-border)] px-3 py-2 text-sm text-[var(--color-tron-text-secondary)]">Cancel</button>
			</div>
		</form>
	</div>
{/if}
