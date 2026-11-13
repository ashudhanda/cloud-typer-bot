// Boot order: the health server comes first, then the Telegram bot. Render
// needs a bound port to mark the service live, and UptimeRobot pings
// `/health` to keep the free instance awake — the bot's long-polling then
// runs on top of it.
// dotenv must load before ./bot is required below: bot.js reads BOT_TOKEN
// and OWNER_ID at require time, so requiring it first would lock in empty
// values for the whole process even if .env were loaded afterwards.
require('dotenv').config();
const express = require('express');

const app = express();
// Parsed as a number: passing a non-numeric PORT string straight to
// listen() would make express treat it as a unix-socket path, not a port.
// An out-of-range port (negative, or above 65535) is worse — listen()
// throws and kills the process with a bare stack trace — so anything
// outside 1-65535 falls back to 3000, like a missing PORT.
const PORT_RAW = Number.parseInt(process.env.PORT, 10);
const PORT = Number.isInteger(PORT_RAW) && PORT_RAW >= 1 && PORT_RAW <= 65535 ? PORT_RAW : 3000; // render injects PORT; 3000 is for local runs

// '/' only proves the service is up — uptimerobot and render's health checks live on /health.
app.get('/', (_req, res) => res.send('cloud-typer-bot alive'));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

const server = app.listen(PORT, () => console.log(`health server on :${PORT}`));
// Without this, a port clash (or a bad PORT value) throws uncaught and kills
// the process with a bare stack trace — log it plainly and exit non-zero so
// Render restarts the service instead of leaving it wedged.
server.on('error', (err) => {
  console.error(`health server failed to bind :${PORT} — ${err.message}`);
  process.exit(1);
});

// Render stops the service with SIGTERM (SIGKILL follows ~30s later): close
// the health server and exit promptly instead of dying mid-request, so a
// redeploy never leaves a health check hanging. The 5s cap bounds the wait —
// telegram polling holds the loop open, so an unref'd timer forces the exit
// once the grace period is up.
function shutdown(signal) {
  console.log(`received ${signal} — shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// starts last, after the health server binds its port — render marks the
// service live only once something is listening, so telegram polling must
// never block or precede the bind above.
require('./bot').startBot();
