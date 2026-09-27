import { loadConfig, type Config, type Env } from "./config";
import { shouldRun } from "./gate";
import { formatRunLine, formatTime, runOnce } from "./sync";

/** The subset of Cloudflare's ScheduledController this handler uses. */
interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    let config: Config;
    try {
      config = loadConfig(env);
    } catch (err) {
      console.error(`config error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (!shouldRun(controller.scheduledTime, config.runEveryMinutes)) return;

    const now = new Date(controller.scheduledTime);
    try {
      const result = await runOnce(config, fetch, now);
      console.log(formatRunLine(result, config.timezone));
    } catch (err) {
      console.error(
        `${formatTime(now, config.timezone)} ${config.timezone} | failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};
