/**
 * KB2-39 diagnostic — print deriveChains() over the live board: every chain
 * (milestone DAGs first, then unanchored), its dependency order, next-up
 * markers, and per-task behind/also counts. Read-only.
 *
 *   npx tsx scripts/diag-chains.ts
 */
import * as dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { KanbanTask } from '../src/lib/server/db';
import { deriveChains } from '../src/lib/server/kanban/chains';

async function main() {
	const r = await deriveChains();
	const titles = new Map<string, string>();
	for (const t of (await KanbanTask.find({ archived: false }).select('_id trackingNumber title status').lean()) as any[]) {
		titles.set(String(t._id), `${t.trackingNumber ?? '-'} ${String(t.title).slice(0, 44)} [${t.status}]`);
	}
	for (const c of r.chains) {
		console.log(
			`\n== ${c.kind} ${c.name} (${c.trackingNumber ?? '-'}) due ${c.dueDate ?? '-'} plan=${c.planTitle ?? '-'}` +
				` total ${c.total} done ${c.done} board ${c.board} tier1 ${c.tier1} nextUp ${c.nextUp.length}`
		);
		const show = Math.min(c.order.length, Number(process.env.ROWS ?? 14));
		c.order.slice(0, show).forEach((id, i) => {
			const ref = r.byTask[id];
			console.log(`   ${String(i + 1).padStart(2)} ${ref?.nextUp ? '▶' : ' '} ${titles.get(id)} behind=${ref?.behind} also=${ref?.also.length}`);
		});
		if (c.order.length > show) console.log(`   … ${c.order.length - show} more`);
	}
	console.log(`\nwired tasks (byTask): ${Object.keys(r.byTask).length}`);
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
