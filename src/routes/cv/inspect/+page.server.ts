import { redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const projects = await CvProject.find({ modelStatus: 'trained' })
		.select('_id name projectType modelStatus')
		.sort({ name: 1 })
		.lean();

	return {
		projects: JSON.parse(JSON.stringify(projects))
	};
};

export const config = { maxDuration: 60 };
