/**
 * Documented exit codes, imported by callers instead of hard-coding
 * integers. 0 to 2 are the CI runner's, and are part of its published
 * contract; the local runner reuses them and adds its own above.
 */

export const EXIT_OK = 0;
export const EXIT_GATE_FAILED = 1;
export const EXIT_INFRA_ERROR = 2;

/**
 * `dev` only: another runner already holds this connection.
 *
 * Distinct from EXIT_INFRA_ERROR because it is not a fault to retry: the
 * refusal stands for as long as the holder keeps polling, and a script can
 * tell the two apart without parsing output.
 */
export const EXIT_RUNNER_BUSY = 3;
