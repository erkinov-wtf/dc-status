/** True when the scheduled minute is a multiple of the run interval. */
export function shouldRun(scheduledTimeMs: number, runEveryMinutes: number): boolean {
  return Math.floor(scheduledTimeMs / 60_000) % runEveryMinutes === 0;
}
