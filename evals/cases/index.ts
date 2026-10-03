import type { EvalCase } from '../src/case';
import { validateCases } from '../src/case';
import { injectionCases } from './injection';
import { refusalCases } from './refusals';
import { scenarioCases } from './scenarios';
import { toolCases } from './tools';

/**
 * All 17 evals (PLAN §6 M5): 5 scenario cards, 3 more write attempts, 1 prompt injection, 8 tool-specific
 * (together every tool is required by at least one case).
 * Validated at import time, so a malformed case fails before any model call is made.
 */
export const ALL_CASES: readonly EvalCase[] = validateCases([
  ...scenarioCases,
  ...refusalCases,
  ...injectionCases,
  ...toolCases,
]);

export { injectionCases, refusalCases, scenarioCases, toolCases };
