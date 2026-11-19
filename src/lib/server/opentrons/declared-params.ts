/**
 * The `variable_name="…"` literals a .py declares that the robot's analysed
 * run-time parameter list does not carry (2026-11-19).
 *
 * An Opentrons RTP whose description is over 100 characters (or display name over
 * 30) can leave the analysis 'completed' while every parameter declared after it is
 * silently missing. The stage Deploy refuses such an upload. Parameters a .py
 * declares in a loop (hole_01_dx …) have no literal and are not checked here.
 */
export function missingDeclaredParams(content: string, parametersSchema: unknown): string[] {
	const have = new Set(((Array.isArray(parametersSchema) ? parametersSchema : []) as any[]).map((p) => p?.variableName));
	const declared = [...String(content).matchAll(/variable_name\s*=\s*["']([A-Za-z0-9_]+)["']/g)].map((m) => m[1]);
	return [...new Set(declared)].filter((n) => !have.has(n));
}
