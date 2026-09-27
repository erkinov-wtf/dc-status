import { readStatus, writeStatus } from "../src/discord";

process.loadEnvFile(".dev.vars");
const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN missing from .dev.vars");

const expiresAt = new Date(Date.now() + 10 * 60_000);
await writeStatus(token, { text: "в пути", emoji: "🚗", expiresAt }, fetch);
const back = await readStatus(token, fetch);

console.log("read back:", back);
console.log(`Open Discord: the bubble should show 🚗 в пути.`);
console.log(`It should disappear by itself at ${expiresAt.toLocaleTimeString()} (10 minutes from now).`);
