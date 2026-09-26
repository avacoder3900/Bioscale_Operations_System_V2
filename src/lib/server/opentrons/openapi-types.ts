/**
 * Moved to $lib/opentrons/openapi-types (OT2-TAILNET-5 S10a) so browser code can
 * type the robot API without importing $lib/server. Kept as a re-export for the
 * server callers and scripts that still import this path.
 */
export type * from '../../opentrons/openapi-types';
