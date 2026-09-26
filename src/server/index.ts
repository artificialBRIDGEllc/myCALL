import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app } = await buildApp(config);

app.log.info(
  {
    transcription: config.deepgram ? config.deepgram.model : "off (set DEEPGRAM_API_KEY)",
    aiReviewer: config.reviewer?.name ?? "off (set ANTHROPIC_API_KEY)",
    auth: config.apiToken ? "token required" : "OPEN — set MYCALL_API_TOKEN before exposing this server",
  },
  "myCALL starting",
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: config.port, host: config.host });
