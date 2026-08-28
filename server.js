require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// render needs a port bound + uptimerobot pings this to keep the free instance awake
app.get('/', (_req, res) => res.send('cloud-typer-bot alive'));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => console.log(`health server on :${PORT}`));

require('./bot').startBot();
