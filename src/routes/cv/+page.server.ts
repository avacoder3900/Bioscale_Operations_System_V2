import { redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const projects = await CvProject.find().sort({ createdAt: -1 }).lean();

	return {
		projects: JSON.parse(JSON.stringify(projects))
	};
};

export const config = { maxDuration: 60 };
