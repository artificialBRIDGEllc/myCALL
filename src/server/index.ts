import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
// Deployments that hold real calls set MYCALL_REQUIRE_TOKEN=true: refuse to start open rather than expose them.
if (process.env.MYCALL_REQUIRE_TOKEN === "true" && !config.apiToken) {
  console.error("MYCALL_REQUIRE_TOKEN is set but MYCALL_API_TOKEN is empty. Refusing to start without a password.");
  process.exit(1);
}
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
