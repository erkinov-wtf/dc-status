import { loadConfig, type Env } from "./config";
import { shouldRun } from "./gate";
import { formatRunLine, formatTime, runOnce } from "./sync";

/** The subset of Cloudflare's ScheduledController this handler uses. */
interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    let config;
    try {
      config = loadConfig(env);
    } catch (err) {
      console.error(`config error: ${(err as Error).message}`);
      return;
    }

    if (!shouldRun(controller.scheduledTime, config.runEveryMinutes)) return;

    const now = new Date(controller.scheduledTime);
    try {
      const result = await runOnce(config, fetch, now);
      console.log(formatRunLine(result, config.timezone));
    } catch (err) {
      console.error(`${formatTime(now, config.timezone)} ${config.timezone} | failed: ${(err as Error).message}`);
    }
  },
};
