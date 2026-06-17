import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	console.log('USERS named "nick" (case-insensitive):');
	const nicks = await db.collection('users').find({
		username: { $regex: /^nick/i }
	}).project({ _id: 1, username: 1, email: 1, firstName: 1, lastName: 1 }).toArray();
	for (const u of nicks as any[]) {
		console.log(`  ${u._id}  username=${u.username}  name=${u.firstName ?? ''} ${u.lastName ?? ''}  email=${u.email ?? ''}`);
	}

	console.log('\nKanban projects (active, sorted):');
	const projects = await db.collection('kanban_projects').find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).toArray();
	for (const p of projects as any[]) {
		console.log(`  ${p._id}  name="${p.name}"  color=${p.color}  sortOrder=${p.sortOrder}`);
	}

	console.log('\nRecent kanban tasks (5 most recent):');
	const recent = await db.collection('kanban_tasks').find({}).sort({ createdAt: -1 }).limit(5).toArray();
	for (const t of recent as any[]) {
		console.log(`  ${t._id}  "${t.title}"  status=${t.status}  project=${t.project?.name}  assignee=${t.assignee?.username}  due=${t.dueDate}`);
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
