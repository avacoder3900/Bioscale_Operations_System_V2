/**
 * One-off (2026-11-17): put the "Cricut: Heat Shield" procedure on the live SPU Assembly WI.
 *
 * - Adds procedure section "Cricut: Heat Shield" (tab after the sub-assemblies; needs the
 *   'procedure' section type from PR #134, so run only after that is deployed).
 * - Adds its 14 steps, text verbatim from the "Work Instruction SB" Google Doc (photos are added
 *   separately — they were not available as files).
 * - Puts the Yes/No question on Sub-Assembly 2 "Add Heat Shield to Heater Block":
 *   "Is the heat shield already present on the heater block?" — No → Cricut: Heat Shield.
 *
 * Goes through the same service functions as the WI editor, so each change is a normal revision
 * (changedBy = ACTOR, default "claude-code"). Dry-run by default; APPLY=1 to write. Idempotent:
 * an existing procedure is reused, steps are only added to an empty one, and an existing question
 * is left alone.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/add-cricut-heat-shield-2026-11-17.ts
 *   APPLY=1 npx tsx --tsconfig tsconfig.json scripts/add-cricut-heat-shield-2026-11-17.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../src/lib/server/db/connection';
import { getDeviceAssemblyWI, addSection, addStep, setStepBranch } from '../src/lib/server/services/device-assembly-wi';

const APPLY = process.env.APPLY === '1';
const actor = { _id: process.env.ACTOR_ID ?? 'claude-code', username: process.env.ACTOR ?? 'claude-code' };

const TITLE = 'Cricut: Heat Shield';
const QUESTION = 'Is the heat shield already present on the heater block?';
const STEPS = [
	'Take a cricut cutting mat and align aluminum (or other material) with 1 inch line.',
	'Make sure the mat is the correct, rectangular 12-inch by 24-inch mat.',
	'Open the specific file/design for our Aluminum Cutting',
	'Press “Make It” button shown in the screenshot in Step 2',
	'Align the design to the squares on the mat. Make sure the corners are overlapping each other.',
	'Press left on the left arrow key on the keyboard 7 times.',
	'Make sure you are connected either through Bluetooth or through the USB-C cable.',
	'Click on the green text, “Browse All Materials” underneath the Bookmarked materials.',
	'Click the green text at the bottom labeled “Material Settings”',
	'Scroll all the way down, then select “Add New Material”, name it something recognizable.',
	'Change from “Fine-Point Blade to Deep-Point Blade”, then slide the pressure down to the lowest (it should be 70).',
	'Save your material and bookmark it for easy access.',
	'Select your material, keep pressure at Default. Note: lower pressure setting has been tied but no observable difference)',
	'After ensuring tape is securely flat, either from the sticky mat or additional tape on the ends that aren’t cut, load the mat fully pressed against the rubber gray parts of the Cricut, then press Go.'
];

const findProcedure = (wi: any) => wi.sections.find((s: any) => s.type === 'procedure' && String(s.title).trim().toLowerCase() === TITLE.toLowerCase());
const findHeatShieldStep = (wi: any) => wi.sections.find((s: any) => s.number === 2)?.steps.find((st: any) => /heat shield/i.test(st.title)) ?? null;

async function main() {
	await connectDB();
	let wi = await getDeviceAssemblyWI();
	if (!wi) throw new Error('No SPU Assembly WI found');
	let proc = findProcedure(wi);
	let step = findHeatShieldStep(wi);
	console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} against database "${mongoose.connection.db?.databaseName}" — WI v${wi.currentVersion}, actor ${actor.username}`);
	console.log(`  procedure "${TITLE}": ${proc ? `exists as tab #${proc.number} with ${proc.steps.length} steps` : 'not there yet → would add'}`);
	console.log(`  steps: ${proc && proc.steps.length ? 'already has steps → leave' : `would add ${STEPS.length}`}`);
	console.log(`  Sub-Assembly 2 heat shield step: ${step ? `step ${step.stepNumber} "${step.title}"${step.branch ? ` — already asks "${step.branch.question}" → leave` : ' → would add the question'}` : 'NOT FOUND'}`);
	if (!step) throw new Error('Sub-Assembly 2 has no step mentioning the heat shield — not changing anything');
	if (!APPLY) return;

	if (!proc) {
		const r = await addSection(actor, { title: TITLE, type: 'procedure' });
		console.log(`  ${r.summary} — v${r.version}`);
		wi = await getDeviceAssemblyWI();
		proc = findProcedure(wi);
	}
	if (!proc.steps.length) {
		for (const text of STEPS) await addStep(actor, proc.number, { title: text, instructionsHtml: `<p>${text}</p>` });
		console.log(`  added ${STEPS.length} steps to ${TITLE}`);
	}
	wi = await getDeviceAssemblyWI();
	proc = findProcedure(wi);
	step = findHeatShieldStep(wi);
	if (!step.branch) {
		const r = await setStepBranch(actor, 2, step._id, { question: QUESTION, noSectionId: proc._id });
		console.log(`  ${r.summary} — v${r.version}`);
	}
	wi = await getDeviceAssemblyWI();
	proc = findProcedure(wi);
	step = findHeatShieldStep(wi);
	console.log(`done: WI v${wi.currentVersion} — "${proc.title}" tab #${proc.number} with ${proc.steps.length} steps; Sub-Assembly 2 step ${step.stepNumber} asks "${step.branch?.question}"`);
}

main()
	.then(() => mongoose.disconnect())
	.catch(async (e) => {
		console.error(e);
		await mongoose.disconnect();
		process.exit(1);
	});
