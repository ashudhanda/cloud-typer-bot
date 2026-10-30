const fs = require('fs');
const path = require('path');
const waka = require('./waka');

// Typed output lands here: one timestamped file per queued source file,
// named so reruns never overwrite earlier runs. Created at require time so
// the bot's /getfile fallback can always list it, even before any run.
const OUT_DIR = path.join(__dirname, 'out');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// pace multiplies the base per-char delay: 1.0 = normal, above 1 = slower,
// below 1 = faster. picking 'slow' simply stretches the same run over ~1.35x
// the inter-char pauses — duration and heartbeat cadence are untouched.
const SPEED_PROFILES = {
  slow: { pace: 1.35 },
  normal: { pace: 1.0 },
  fast: { pace: 0.7 },
};

// uniform random float in [min, max) — every pacing jitter below (typing
// pauses, heartbeat intervals, break lengths) flows through this one helper.
const rand = (min, max) => min + Math.random() * (max - min);

class TyperRun {
  /**
   * Build a run from the bot's wizard options. Normalizes each queued file
   * (see the inline comment below) and snapshots the run config; timers
   * and tallies start empty until start() is called.
   *
   * @param {object} opts
   * @param {Array<{content: string, fileName: string}>} opts.files queued source files
   * @param {string} [opts.project] dashboard project name (or DEFAULT_PROJECT env, else 'myproject')
   * @param {number} opts.durationMin total run duration in minutes
   * @param {string} opts.mode 'realtime' | 'instant'
   * @param {string} [opts.speed] 'slow' | 'normal' | 'fast' (unknown names fall back to normal)
   * @param {Function} [opts.onFileDone] called with (run, fileIndex) per finished file
   * @param {Function} [opts.onFinish] called with (run) when the run completes
   */
  constructor(opts) {
    // Normalize each queued file up front: \r\n -> \n so char math matches the
    // content we type and send; precompute line-start offsets so lineInfo()
    // can binary-search them later; give every run a unique outPath (timestamp
    // + random suffix) so reruns never overwrite earlier files.
    this.files = (opts.files || []).map((f) => {
      const content = String(f.content || '').replace(/\r\n/g, '\n');
      const lineStarts = [0];
      for (let i = 0; i < content.length; i++) {
        if (content[i] === '\n') lineStarts.push(i + 1);
      }
      return {
        content,
        fileName: f.fileName || 'code.txt',
        lineStarts,
        totalLines: lineStarts.length,
        outPath: path.join(
          OUT_DIR,
          `${Date.now()}-${Math.floor(rand(100, 999))}-${f.fileName || 'code.txt'}`
        ),
      };
    });
    this.project = opts.project || process.env.DEFAULT_PROJECT || 'myproject';
    this.durationMin = opts.durationMin;
    this.mode = opts.mode; // 'realtime' | 'instant'
    // Unknown speed names fall back to normal — the wizard only offers known
    // ones, so this is just a safety net.
    this.speed = SPEED_PROFILES[opts.speed] || SPEED_PROFILES.normal;
    this.fileIndex = 0; // which file is being typed
    this.index = 0; // char index inside the current file
    this.heartbeatsSent = 0;
    this.heartbeatsFailed = 0;
    this.startedAt = Date.now();
    this.done = false;
    this.stopped = false;
    this.timer = null;
    this.hbTimer = null;
    this.onFileDone = opts.onFileDone || (() => {});
    this.onFinish = opts.onFinish || (() => {});
    this.totalCharsAll = this.files.reduce((s, f) => s + f.content.length, 0);
  }

  /**
   * Spoofed file path shown on the dashboard. A static windows-style path
   * blends the run with the existing machine's stats (see the README's
   * "how the dashboard reads it") instead of exposing the render box —
   * only the language (from the extension) and project are real.
   */
  entityFor(f) {
    return `C:\\Users\\WELCOME\\${this.project}\\${f.fileName}`;
  }

  /**
   * Binary-search the precomputed line-start offsets to find which line a
   * character index falls on.
   *
   * @param {object} f   normalized file from the constructor (lineStarts, content)
   * @param {number} idx 0-based character index inside the file
   * @returns {{lineno: number, cursorpos: number}} 1-based line number and
   *          1-based cursor column, the shape the wakatime heartbeat payload expects
   */
  lineInfo(f, idx) {
    const arr = f.lineStarts;
    let lo = 0;
    let hi = arr.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= idx) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return { lineno: ans + 1, cursorpos: idx - arr[ans] + 1 };
  }

  /**
   * Build the heartbeat payload for the current cursor position. idx is
   * clamped to the file bounds; timeOverride (unix seconds) lets instant
   * mode backdate beats, while realtime leaves it unset for "now".
   *
   * @param {object} f normalized file from the constructor
   * @param {number} idx 0-based char index of the cursor
   * @param {boolean} isWrite true = save beat, false = passive typing beat
   * @param {number} [timeOverride] unix-seconds timestamp for backfilled beats
   * @returns {object} wakatime heartbeat payload for the clamped cursor position
   */
  heartbeatFor(f, idx, isWrite, timeOverride) {
    const clamped = Math.max(0, Math.min(idx, f.content.length));
    const { lineno, cursorpos } = this.lineInfo(f, clamped);
    return waka.makeHeartbeat({
      entity: this.entityFor(f),
      project: this.project,
      time: timeOverride !== undefined ? timeOverride : Date.now() / 1000,
      lineno,
      cursorpos,
      lines: f.totalLines,
      isWrite,
    });
  }

  /**
   * Fire one heartbeat for the current cursor position. Never throws —
   * bumps the heartbeatsSent/heartbeatsFailed tallies so /status can
   * report them.
   *
   * @param {boolean} isWrite true = save beat, false = passive typing beat
   */
  async fireHeartbeat(isWrite) {
    // Clamp fileIndex: it can point one past the last file in the gap between
    // a file finishing (onFileDone) and finish() marking the run done.
    const f = this.files[Math.min(this.fileIndex, this.files.length - 1)];
    if (!f) return;
    const res = await waka.sendHeartbeat(this.heartbeatFor(f, this.index, isWrite));
    if (res.ok) this.heartbeatsSent += 1;
    else {
      this.heartbeatsFailed += 1;
      if (res.status) console.error('heartbeat failed:', res.status);
    }
  }

  /**
   * Live typing loop on timers. Each file gets a share of the total duration
   * proportional to its size; chars land in 1-4 bursts with human jitter, a
   * longer pause at line ends and an occasional thinking pause. A separate
   * ~2min heartbeat loop runs alongside (first beat after 8s so the
   * dashboard lights up right away). Both timers live on this.timer /
   * this.hbTimer so stop() can clear them.
   */
  startRealtime() {
    const totalMs = this.durationMin * 60 * 1000;

    const runFile = () => {
      if (this.stopped || this.done) return;
      const f = this.files[this.fileIndex];
      // bigger file gets a bigger share of the total duration
      const share = f.content.length / Math.max(1, this.totalCharsAll);
      const fileMs = Math.max(30000, totalMs * share);
      // per-char base delay: the file's share of the total run time divided
      // by its char count, scaled by the speed pace (slow 1.35x ... fast
      // 0.7x). the 20ms floor stops long files collapsing to zero-delay bursts.
      const baseDelay = Math.max(20, (fileMs / Math.max(1, f.content.length)) * this.speed.pace);
      fs.writeFileSync(f.outPath, ''); // fresh file — realtime appends chars below, instant mode writes it whole later

      const step = () => {
        if (this.stopped || this.done) return;
        // small bursts of 1-4 chars feel more like a person than a fixed metronome
        const burst = Math.min(1 + Math.floor(rand(0, 3.2)), f.content.length - this.index);
        if (burst > 0) {
          fs.appendFileSync(f.outPath, f.content.slice(this.index, this.index + burst));
          this.index += burst;
        }
        if (this.index >= f.content.length) {
          this.fireHeartbeat(true); // save on file finish
          const doneIdx = this.fileIndex;
          this.onFileDone(this, doneIdx);
          this.fileIndex += 1;
          this.index = 0;
          if (this.fileIndex >= this.files.length) {
            this.finish();
            return;
          }
          // human-ish break between files (heartbeats keep flowing on the next file)
          this.timer = setTimeout(runFile, rand(20000, 60000));
          return;
        }
        let delay = baseDelay * burst * rand(0.45, 1.6);
        if (f.content[this.index - 1] === '\n') delay += rand(250, 1400); // end-of-line pause
        if (Math.random() < 0.006) delay += rand(2500, 9000); // occasional thinking pause
        this.timer = setTimeout(step, delay);
      };
      step();
    };
    // small delay before the first file starts typing (kick off on the next
    // tick rather than synchronously inside the telegram message handler).
    this.timer = setTimeout(runFile, 500);

    // throttled like the real plugin: ~1 heartbeat per 2 min while active, plus saves
    const hbLoop = async () => {
      if (this.stopped || this.done) return;
      await this.fireHeartbeat(this.heartbeatsSent % 15 === 14); // every 15th beat = a "save"
      this.hbTimer = setTimeout(hbLoop, rand(105000, 135000));
    };
    // the first beat fires after just 8s (not ~2 min) so the dashboard shows
    // the run as active right away; the loop above then settles into the
    // steady ~2min cadence for the rest of the run.
    this.hbTimer = setTimeout(hbLoop, 8000);
  }

  /**
   * Instant mode: backfill the whole run in one bulk sync instead of
   * typing live. Heartbeats are swept from the run's start to now at the
   * realtime ~2min cadence, each mapped back to the file in progress at
   * that moment; the finished files are then written whole to out/ and
   * delivered via onFileDone, and the run finishes immediately.
   */
  async startInstant() {
    const now = Date.now() / 1000;
    const start = now - this.durationMin * 60;
    const beats = [];

    // map global progress -> which file we're in (proportional by size)
    const bounds = [];
    let acc = 0;
    for (const f of this.files) {
      acc += f.content.length;
      bounds.push(acc);
    }

    // sweep from the run's start to now, emitting one heartbeat every ~2 min
    // (the same cadence as the realtime loop) and mapping each timestamp back
    // to the file the typist would have been on at that moment.
    let t = start;
    let i = 0;
    while (t < now) {
      const frac = (t - start) / (now - start);
      const globalIdx = Math.floor(frac * this.totalCharsAll);
      let fi = 0;
      while (fi < bounds.length - 1 && globalIdx >= bounds[fi]) fi += 1;
      const prevBound = fi === 0 ? 0 : bounds[fi - 1];
      const f = this.files[fi];
      const localIdx = Math.min(globalIdx - prevBound, f.content.length);
      const atFileEnd = localIdx >= f.content.length - 1;
      // every 15th beat is marked a "save" — the same ratio as the realtime
      // loop — plus a save at the end of each file, so the backfilled pattern
      // looks like a live typing session.
      beats.push(this.heartbeatFor(f, localIdx, i % 15 === 14 || atFileEnd, t));
      i += 1;
      t += rand(100, 135); // one beat every ~2 min, same cadence as a throttled plugin
    }
    const last = this.files[this.files.length - 1];
    beats.push(this.heartbeatFor(last, last.content.length, true, now)); // final save

    const res = await waka.sendBulk(beats);
    this.heartbeatsSent = res.sent;
    this.heartbeatsFailed = res.failed;
    for (let fi = 0; fi < this.files.length; fi++) {
      fs.writeFileSync(this.files[fi].outPath, this.files[fi].content);
      this.onFileDone(this, fi);
    }
    this.fileIndex = this.files.length;
    this.finish();
  }

  /**
   * Start the run in the configured mode. Instant mode backfills everything
   * in one promise (await it); realtime runs on timers and returns
   * undefined — track it via .done or the bot's /status.
   *
   * @throws {Error} when no files are queued
   * @returns {Promise<void>|undefined} the instant-mode promise, or
   *          undefined for a realtime run
   */
  start() {
    if (!this.files.length) throw new Error('no files queued');
    if (this.mode === 'instant') return this.startInstant();
    this.startRealtime();
    return undefined;
  }

  /**
   * Halt an active run: sets stopped AND done (done alone would leave
   * /start and /status thinking a finished run is still live), and clears
   * both timers so no more typing steps or heartbeats fire after this.
   */
  stop() {
    this.stopped = true;
    this.done = true; // mark done too, otherwise /start and /status think it's still running
    if (this.timer) clearTimeout(this.timer);
    if (this.hbTimer) clearTimeout(this.hbTimer);
  }

  // Mark the run done, clear both timers (no further typing or heartbeats),
  // then hand the completed run back to the bot via onFinish.
  finish() {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.hbTimer) clearTimeout(this.hbTimer);
    this.onFinish(this);
  }

  /**
   * Point-in-time snapshot of the run, consumed by the bot's /status command.
   * percent/charsDone/charsTotal track typing progress; elapsedMin is measured
   * from construction while etaMin is remaining scheduled time for realtime
   * runs (0 in instant mode; an early stop keeps counting down to the
   * scheduled end, so it may read > 0 after /stop). filesDone counts completed
   * files, so the currently-typing file is filesDone + 1.
   *
   * @returns {object} run snapshot (percent, charsDone/charsTotal,
   *          filesDone/filesTotal, currentFile, elapsedMin, etaMin,
   *          heartbeatsSent/heartbeatsFailed, done, stopped, mode, project)
   */
  status() {
    const completedChars =
      this.mode === 'instant' && this.done
        ? this.totalCharsAll
        : this.files.slice(0, this.fileIndex).reduce((s, f) => s + f.content.length, 0) + this.index;
    const pct = this.totalCharsAll ? (completedChars / this.totalCharsAll) * 100 : 100;
    const elapsedMin = (Date.now() - this.startedAt) / 60000;
    const etaMin = this.mode === 'instant' ? 0 : Math.max(0, this.durationMin - elapsedMin);
    const cur = this.files[Math.min(this.fileIndex, this.files.length - 1)];
    return {
      stopped: this.stopped,
      percent: pct.toFixed(1),
      charsDone: completedChars,
      charsTotal: this.totalCharsAll,
      filesDone: this.mode === 'instant' && this.done ? this.files.length : this.fileIndex,
      filesTotal: this.files.length,
      currentFile: cur ? cur.fileName : '',
      elapsedMin: elapsedMin.toFixed(1),
      etaMin: etaMin.toFixed(0),
      heartbeatsSent: this.heartbeatsSent,
      heartbeatsFailed: this.heartbeatsFailed,
      done: this.done,
      mode: this.mode,
      project: this.project,
    };
  }
}

module.exports = { TyperRun, OUT_DIR };
