// Boot order: the health server comes first, then the Telegram bot. Render
// needs a bound port to mark the service live, and UptimeRobot pings
// `/health` to keep the free instance awake — the bot's long-polling then
// runs on top of it.
require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000; // render injects PORT; 3000 is for local runs

app.get('/', (_req, res) => res.send('cloud-typer-bot alive'));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => console.log(`health server on :${PORT}`));

require('./bot').startBot();
