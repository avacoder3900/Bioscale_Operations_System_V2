/**
 * The robot-arm line's own rack calibration (2026-11-19): the Deck Calibration
 * Studio's load + actions, re-exported. The Studio reads this page's PATH and
 * forces the rack kind and the 'arm' line, so everything taught here goes to
 * arm_line_labware_offsets and reaches only the arm stage protocol's runs. The
 * normal wax / reagent fills keep reading robot_labware_offsets.
 */
export { load, actions } from '../../../deck-calibration/+page.server';
