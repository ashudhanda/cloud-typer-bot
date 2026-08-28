const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { TyperRun, OUT_DIR } = require('./typer');

const TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = String(process.env.OWNER_ID || '').trim();

let bot = null;
let currentRun = null;
let queue = []; // [{ content, fileName }] — send as many files as you like, they stack up
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

function queueSummary() {
  const total = queue.reduce((s, f) => s + f.content.length, 0);
  const names = queue.map((f) => f.fileName).join(', ');
  return `${queue.length} file${queue.length > 1 ? 's' : ''} (${total.toLocaleString()} chars) — ${names}`;
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
        '/getfile — download the typed files\n' +
        '/queue — see what\'s loaded\n' +
        '/clearqueue — drop all loaded files\n' +
        '/name <file> — rename the last loaded file\n' +
        '/id — your chat id (for OWNER_ID)\n' +
        '/help — this list\n\n' +
        'flow: send files one by one (they stack up) → /start → duration → mode → speed → project → ▶ start. one total duration is split across the files by size.'
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
    if (!queue.length) {
      bot.sendMessage(chatId, 'send me the code first — upload files (html/css/js anything) or paste code (min 200 chars). send as many as you like, they stack up.');
      return;
    }
    askDuration(chatId);
  });

  bot.onText(/\/queue/, (msg) => {
    const chatId = msg.chat.id;
    if (!isOwner(chatId)) return;
    if (!queue.length) {
      bot.sendMessage(chatId, 'queue is empty — send files or paste code.');
      return;
    }
    bot.sendMessage(chatId, `loaded: ${queueSummary()}\n\n/start to run, /clearqueue to reset.`);
  });

  bot.onText(/\/clearqueue/, (msg) => {
    const chatId = msg.chat.id;
    if (!isOwner(chatId)) return;
    queue = [];
    bot.sendMessage(chatId, 'queue cleared. send fresh files when ready.');
  });

  bot.onText(/\/name (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    if (!isOwner(chatId)) return;
    if (!queue.length) {
      bot.sendMessage(chatId, 'no file loaded yet — upload or paste code first.');
      return;
    }
    const name = (match[1] || '').trim();
    if (!/^[\w.\- ]{1,80}$/.test(name)) {
      bot.sendMessage(chatId, 'weird name — keep it simple, like style.css');
      return;
    }
    queue[queue.length - 1].fileName = name; // renames the last added file
    bot.sendMessage(chatId, `renamed to ${name}\n\nloaded: ${queueSummary()}`);
  });

  bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    if (!isOwner(chatId)) return;
    if (!currentRun) {
      bot.sendMessage(chatId, 'no run yet. send files, then /start.');
      return;
    }
    const s = currentRun.status();
    const label = s.done ? (s.stopped ? '🛑 stopped' : '✅ finished') : '⏳ running';
    bot.sendMessage(
      chatId,
      `${label} — file ${Math.min(s.filesDone + (s.done ? 0 : 1), s.filesTotal)}/${s.filesTotal}: ${s.currentFile}\n` +
        `• overall: ${s.percent}% (${s.charsDone}/${s.charsTotal} chars)\n` +
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
    const s = currentRun.status();
    // send whatever got typed in the current (partial) file
    try {
      const f = currentRun.files[Math.min(currentRun.fileIndex, currentRun.files.length - 1)];
      if (f && fs.existsSync(f.outPath) && fs.statSync(f.outPath).size > 0) {
        await bot.sendDocument(chatId, f.outPath, { caption: 'partial (stopped mid-file)' }, { filename: f.fileName });
      }
    } catch {}
    await bot.sendMessage(
      chatId,
      `🛑 stopped at ${s.percent}% overall (file ${s.filesDone + 1}/${s.filesTotal}). completed files were already delivered. heartbeats sent so far (${s.heartbeatsSent}) stay on the dashboard.`
    );
  });

  bot.onText(/\/getfile/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isOwner(chatId)) return;
    let sent = 0;
    if (currentRun) {
      for (const f of currentRun.files) {
        try {
          if (fs.existsSync(f.outPath) && fs.statSync(f.outPath).size > 0) {
            await bot.sendDocument(chatId, f.outPath, {}, { filename: f.fileName });
            sent += 1;
          }
        } catch {}
      }
    }
    if (!sent) {
      // fall back to the newest files in the out dir
      const files = fs
        .readdirSync(OUT_DIR)
        .map((f) => path.join(OUT_DIR, f))
        .filter((f) => fs.statSync(f).isFile() && fs.statSync(f).size > 0)
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      for (const f of files.slice(0, 5)) {
        try {
          await bot.sendDocument(chatId, f);
          sent += 1;
        } catch {}
      }
    }
    if (!sent) await bot.sendMessage(chatId, 'no file yet — load files and /start a run first.');
  });

  // incoming source as a file upload — stacks into the queue
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
      queue.push({ content: text, fileName: msg.document.file_name || 'uploaded-code.txt' });
      const busy = currentRun && !currentRun.done;
      await bot.sendMessage(
        chatId,
        `added ${msg.document.file_name || 'file'} (${text.length} chars)\nloaded: ${queueSummary()}${busy ? '\n\n(a run is active — these will be used for the next one)' : '\n\n/start when ready, /clearqueue to reset.'}`
      );
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
          await bot.sendMessage(chatId, 'type the total duration in minutes (e.g. 300 for 5h) — it gets split across the queued files by size:');
        } else {
          p.durationMin = parseInt(data.slice(4), 10);
          p.step = 'mode';
          pending.set(chatId, p);
          await bot.sendMessage(chatId, `duration: ${p.durationMin} min total\n\npick mode:`, modeKeyboard());
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
      await bot.sendMessage(chatId, `duration: ${mins} min total\n\npick mode:`, modeKeyboard());
      return;
    }

    if (p && p.step === 'customProj') {
      p.project = msg.text.trim().toLowerCase().replace(/[^a-z0-9\-_ ]/g, '') || 'myproject';
      await showConfirm(chatId, p);
      return;
    }

    if (msg.text.length >= 200) {
      queue.push({ content: msg.text, fileName: 'pasted-code.txt' });
      const busy = currentRun && !currentRun.done;
      await bot.sendMessage(
        chatId,
        `got it — ${msg.text.length} chars added as pasted-code.txt (use /name style.css to rename — the extension sets the language on the dashboard).\nloaded: ${queueSummary()}${busy ? '\n\n(a run is active — these will be used for the next one)' : '\n\n/start when ready.'}`
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
      `ready:\n• files: ${queueSummary()}\n• duration: ${hrs}h total (split by file size)\n• mode: ${p.mode}\n• speed: ${p.speed}\n• project: ${p.project}\n• ~${beats} heartbeats will be sent\n\nstart?`,
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
    if (!queue.length) {
      await bot.sendMessage(chatId, 'queue is empty — send files first.');
      return;
    }
    pending.delete(chatId);
    const filesForRun = queue;
    queue = []; // run owns its copy; new uploads stack for the next run
    currentRun = new TyperRun({
      files: filesForRun,
      project: p.project,
      durationMin: p.durationMin,
      mode: p.mode,
      speed: p.speed,
      onFileDone: async (run, fi) => {
        const f = run.files[fi];
        try {
          await bot.sendDocument(chatId, f.outPath, { caption: `✅ file ${fi + 1}/${run.files.length} done: ${f.fileName}` }, { filename: f.fileName });
        } catch {}
      },
      onFinish: async (run) => {
        const s = run.status();
        await bot.sendMessage(
          chatId,
          `✅ run complete — ${s.filesTotal} file${s.filesTotal > 1 ? 's' : ''} typed\n• heartbeats sent: ${s.heartbeatsSent}${s.heartbeatsFailed ? ` (failed: ${s.heartbeatsFailed})` : ''}\n• project: ${s.project}\n• mode: ${s.mode}\n\nsend more files and /start for the next run.`
        );
      },
    });
    try {
      await currentRun.start();
      await bot.sendMessage(
        chatId,
        p.mode === 'instant'
          ? '⚡ instant run — backfilling heartbeats now, files land in a few seconds...'
          : `⏱ realtime run started — typing ${filesForRun.length} file${filesForRun.length > 1 ? 's' : ''} over ~${(p.durationMin / 60).toFixed(1)}h. each file arrives here as it finishes. /status anytime, /stop to end early.`
      );
    } catch (e) {
      await bot.sendMessage(chatId, `run failed to start: ${e.message || e}`);
    }
  }

  function askDuration(chatId) {
    pending.set(chatId, { step: 'duration' });
    bot.sendMessage(chatId, `loaded: ${queueSummary()}\n\npick total duration:`, {
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
