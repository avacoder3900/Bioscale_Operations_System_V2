// The Robot Arm's wax-fill tab moved onto the Opentron page (2026-10-29); old links land on its section.
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
	redirect(301, '/manufacturing/cart-mfg/robot-arm/opentron#wax-fill');
};
