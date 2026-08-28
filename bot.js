const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { TyperRun, OUT_DIR } = require('./typer');

const TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = String(process.env.OWNER_ID || '').trim();

let bot = null;
let currentRun = null;
let source = null; // { content, fileName }
const pending = new Map(); // chatId -> { step, durationMin, mode, speed, project }

function isOwner(chatId) {
  if (!OWNER_ID) return true; // unlocked until OWNER_ID is set
  return String(chatId) === OWNER_ID;
}

function modeKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '⏱ realtime (types live, safest)', callback_data: 'mode:realtime' }],
        [{ text: '⚡ instant (backfills now, top-up only)', callback_data: 'mode:instant' }],
      ],
    },
  };
}

function startBot() {
  if (!TOKEN) {
    console.error('BOT_TOKEN missing — set it in env vars');
    return;
  }
  bot = new TelegramBot(TOKEN, { polling: true });
  bot.on('polling_error', (e) => console.error('polling error:', e.message));

  bot.onText(/\/id/, (msg) => {
    bot.sendMessage(msg.chat.id, `your chat id: ${msg.chat.id}`);
  });

  bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    if (!isOwner(chatId)) return;
    bot.sendMessage(
      chatId,
      'commands:\n' +
        '/start — configure + launch a run\n' +
        '/status — live progress\n' +
        '/stop — end run, get the partial file\n' +
        '/getfile — download the current/last typed file\n' +
        '/name <file> — rename the loaded source\n' +
        '/id — your chat id (for OWNER_ID)\n' +
        '/help — this list\n\n' +
        'flow: upload/paste code → /start → duration → mode → speed → project → ▶ start'
    );
  });

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (!isOwner(chatId)) return;
    if (!OWNER_ID) {
      bot.sendMessage(chatId, '⚠ bot is unlocked — anyone who finds it can use it. send /id, put that number in the OWNER_ID env var, redeploy.');
    }
    if (currentRun && !currentRun.done) {
      bot.sendMessage(chatId, 'a run is already active. /status to check, /stop to end it.');
      return;
    }
    if (!source) {
      bot.sendMessage(chatId, 'send me the code first — upload a file or paste the code here (min 200 chars). then we pick duration and mode.');
      return;
    }
    askDuration(chatId);
  });

  bot.onText(/\/name (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isOwner(chatId)) return;
    if (!source) {
      bot.sendMessage(chatId, 'no source loaded yet — upload or paste code first.');
      return;
    }
    const name = (match[1] || '').trim();
    if (!/^[\w.\- ]{1,80}$/.test(name)) {
      bot.sendMessage(chatId, 'weird name — keep it simple, like style.css');
      return;
    }
    source.fileName = name;
    bot.sendMessage(chatId, `source renamed to ${name}`);
  });

  bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    if (!isOwner(chatId)) return;
    if (!currentRun) {
      bot.sendMessage(chatId, 'no run yet. upload code, then /start.');
      return;
    }
    const s = currentRun.status();
    const label = s.done ? (s.stopped ? '🛑 stopped' : '✅ finished') : '⏳ running';
    bot.sendMessage(
      chatId,
      `${label} — ${s.fileName}\n` +
        `• progress: ${s.percent}% (${s.charsDone}/${s.charsTotal} chars)\n` +
        `• elapsed: ${s.elapsedMin} min${s.done ? '' : `  • eta: ~${s.etaMin} min`}\n` +
        `• heartbeats: ${s.heartbeatsSent} sent${s.heartbeatsFailed ? `, ${s.heartbeatsFailed} failed` : ''}\n` +
        `• mode: ${s.mode}  • project: ${s.project}`
    );
  });

  bot.onText(/\/stop/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isOwner(chatId)) return;
    if (!currentRun || currentRun.done) {
      bot.sendMessage(chatId, 'nothing running right now.');
      return;
    }
    currentRun.stop();
    try {
      await bot.sendDocument(chatId, currentRun.outPath, {}, { filename: currentRun.fileName });
    } catch {}
    const s = currentRun.status();
    await bot.sendMessage(
      chatId,
      `🛑 stopped at ${s.percent}% — partial file above. heartbeats already sent (${s.heartbeatsSent}) stay on the dashboard.`
    );
  });

  bot.onText(/\/getfile/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isOwner(chatId)) return;
    let file = currentRun ? currentRun.outPath : null;
    if (!file) {
      const files = fs
        .readdirSync(OUT_DIR)
        .map((f) => path.join(OUT_DIR, f))
        .filter((f) => fs.statSync(f).isFile());
      if (files.length) file = files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    }
    if (!file) {
      await bot.sendMessage(chatId, 'no file yet — upload source and /start a run first.');
      return;
    }
    try {
      await bot.sendDocument(chatId, file);
    } catch {
      await bot.sendMessage(chatId, 'failed to send the file, try again.');
    }
  });

  // incoming source as a file upload
  bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    if (!isOwner(chatId)) return;
    try {
      if (msg.document.file_size && msg.document.file_size > 1024 * 1024) {
        await bot.sendMessage(chatId, 'file too big (1MB max) — code files should be tiny.');
        return;
      }
      const link = await bot.getFileLink(msg.document.file_id);
      const res = await fetch(link);
      const text = await res.text();
      source = { content: text, fileName: msg.document.file_name || 'uploaded-code.txt' };
      await bot.sendMessage(chatId, `source loaded: ${source.fileName} (${text.length} chars)\n\nnow /start to configure the run.`);
    } catch {
      await bot.sendMessage(chatId, 'could not read that file — send a plain text/code file.');
    }
  });

  // inline button flow
  bot.on('callback_query', async (q) => {
    const chatId = q.message.chat.id;
    if (!isOwner(chatId)) return;
    const p = pending.get(chatId) || {};
    const data = q.data || '';

    try {
      if (data.startsWith('dur:')) {
        if (data === 'dur:custom') {
          p.step = 'customDur';
          pending.set(chatId, p);
          await bot.sendMessage(chatId, 'type the duration in minutes (e.g. 300 for 5h):');
        } else {
          p.durationMin = parseInt(data.slice(4), 10);
          p.step = 'mode';
          pending.set(chatId, p);
          await bot.sendMessage(chatId, `duration: ${p.durationMin} min\n\npick mode:`, modeKeyboard());
        }
      } else if (data.startsWith('mode:')) {
        p.mode = data.slice(5);
        p.step = 'speed';
        pending.set(chatId, p);
        await bot.sendMessage(chatId, 'typing speed:', {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🐢 slow', callback_data: 'spd:slow' },
                { text: '🚶 normal', callback_data: 'spd:normal' },
                { text: '🏃 fast', callback_data: 'spd:fast' },
              ],
            ],
          },
        });
      } else if (data.startsWith('spd:')) {
        p.speed = data.slice(4);
        p.step = 'project';
        pending.set(chatId, p);
        await bot.sendMessage(chatId, 'project name (shows on the dashboard):', {
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'webos', callback_data: 'proj:webos' },
                { text: 'eswebsite', callback_data: 'proj:eswebsite' },
              ],
              [{ text: 'custom', callback_data: 'proj:custom' }],
            ],
          },
        });
      } else if (data.startsWith('proj:')) {
        if (data === 'proj:custom') {
          p.step = 'customProj';
          pending.set(chatId, p);
          await bot.sendMessage(chatId, 'type the project name:');
        } else {
          p.project = data.slice(5);
          await showConfirm(chatId, p);
        }
      } else if (data === 'go:start') {
        await launchRun(chatId, p);
      } else if (data === 'go:cancel') {
        pending.delete(chatId);
        await bot.sendMessage(chatId, 'cancelled. /start to begin again.');
      }
    } catch (e) {
      console.error('callback error:', e);
    }
    bot.answerCallbackQuery(q.id).catch(() => {});
  });

  // free-text: custom duration, custom project, or pasted source code
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (!isOwner(chatId)) return;
    if (!msg.text || msg.text.startsWith('/')) return;
    const p = pending.get(chatId);

    if (p && p.step === 'customDur') {
      const mins = parseInt(msg.text.trim(), 10);
      if (!Number.isFinite(mins) || mins < 15 || mins > 840) {
        await bot.sendMessage(chatId, 'give a number between 15 and 840 (14h max — keep it human).');
        return;
      }
      p.durationMin = mins;
      p.step = 'mode';
      pending.set(chatId, p);
      await bot.sendMessage(chatId, `duration: ${mins} min\n\npick mode:`, modeKeyboard());
      return;
    }

    if (p && p.step === 'customProj') {
      p.project = msg.text.trim().toLowerCase().replace(/[^a-z0-9\-_ ]/g, '') || 'myproject';
      await showConfirm(chatId, p);
      return;
    }

    if (msg.text.length >= 200) {
      source = { content: msg.text, fileName: 'pasted-code.txt' };
      await bot.sendMessage(
        chatId,
        `got it — ${msg.text.length} chars loaded as source (named pasted-code.txt, use /name style.css to rename — the extension sets the language on the dashboard).\n\nnow /start to configure the run.`
      );
    }
  });

  async function showConfirm(chatId, p) {
    p.step = 'confirm';
    pending.set(chatId, p);
    const hrs = (p.durationMin / 60).toFixed(1);
    const beats = Math.round((p.durationMin * 60) / 117);
    await bot.sendMessage(
      chatId,
      `ready:\n• file: ${source.fileName}\n• duration: ${hrs}h\n• mode: ${p.mode}\n• speed: ${p.speed}\n• project: ${p.project}\n• ~${beats} heartbeats will be sent\n\nstart?`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '▶ start', callback_data: 'go:start' },
              { text: '❌ cancel', callback_data: 'go:cancel' },
            ],
          ],
        },
      }
    );
  }

  async function launchRun(chatId, p) {
    if (currentRun && !currentRun.done) {
      await bot.sendMessage(chatId, 'already running. /stop first.');
      return;
    }
    pending.delete(chatId);
    currentRun = new TyperRun({
      content: source.content,
      fileName: source.fileName,
      project: p.project,
      durationMin: p.durationMin,
      mode: p.mode,
      speed: p.speed,
      onFinish: async (run) => {
        const s = run.status();
        try {
          await bot.sendDocument(chatId, run.outPath, {}, { filename: run.fileName });
        } catch {}
        await bot.sendMessage(
          chatId,
          `✅ done: ${run.fileName}\n• heartbeats sent: ${s.heartbeatsSent}${s.heartbeatsFailed ? ` (failed: ${s.heartbeatsFailed})` : ''}\n• project: ${s.project}\n• mode: ${s.mode}`
        );
      },
    });
    try {
      await currentRun.start();
      await bot.sendMessage(
        chatId,
        p.mode === 'instant'
          ? '⚡ instant run — backfilling heartbeats now, file lands in a few seconds...'
          : `⏱ realtime run started — typing ${source.fileName} for ~${(p.durationMin / 60).toFixed(1)}h. /status anytime, /stop to end early.`
      );
    } catch (e) {
      await bot.sendMessage(chatId, `run failed to start: ${e.message || e}`);
    }
  }

  function askDuration(chatId) {
    pending.set(chatId, { step: 'duration' });
    bot.sendMessage(chatId, `source ready: ${source.fileName} (${source.content.length} chars)\n\npick duration:`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '2h', callback_data: 'dur:120' },
            { text: '4h', callback_data: 'dur:240' },
            { text: '6h', callback_data: 'dur:360' },
          ],
          [
            { text: '8h', callback_data: 'dur:480' },
            { text: '10h', callback_data: 'dur:600' },
          ],
          [{ text: 'custom (minutes)', callback_data: 'dur:custom' }],
        ],
      },
    });
  }

  console.log('telegram bot polling started');
}

module.exports = { startBot };
