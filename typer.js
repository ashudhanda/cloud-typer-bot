const fs = require('fs');
const path = require('path');
const waka = require('./waka');

const OUT_DIR = path.join(__dirname, 'out');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const SPEED_PROFILES = {
  slow: { pace: 1.35 },
  normal: { pace: 1.0 },
  fast: { pace: 0.7 },
};

const rand = (min, max) => min + Math.random() * (max - min);

class TyperRun {
  constructor(opts) {
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

  entityFor(f) {
    // windows-style path so stats blend with the existing machine
    return `C:\\Users\\WELCOME\\${this.project}\\${f.fileName}`;
  }

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

  async fireHeartbeat(isWrite) {
    const f = this.files[Math.min(this.fileIndex, this.files.length - 1)];
    if (!f) return;
    const res = await waka.sendHeartbeat(this.heartbeatFor(f, this.index, isWrite));
    if (res.ok) this.heartbeatsSent += 1;
    else {
      this.heartbeatsFailed += 1;
      if (res.status) console.error('heartbeat failed:', res.status);
    }
  }

  startRealtime() {
    const totalMs = this.durationMin * 60 * 1000;

    const runFile = () => {
      if (this.stopped || this.done) return;
      const f = this.files[this.fileIndex];
      // bigger file gets a bigger share of the total duration
      const share = f.content.length / Math.max(1, this.totalCharsAll);
      const fileMs = Math.max(30000, totalMs * share);
      const baseDelay = Math.max(20, (fileMs / Math.max(1, f.content.length)) * this.speed.pace);
      fs.writeFileSync(f.outPath, '');

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
    this.timer = setTimeout(runFile, 500);

    // throttled like the real plugin: ~1 heartbeat per 2 min while active, plus saves
    const hbLoop = async () => {
      if (this.stopped || this.done) return;
      await this.fireHeartbeat(this.heartbeatsSent % 15 === 14); // every 15th beat = a "save"
      this.hbTimer = setTimeout(hbLoop, rand(105000, 135000));
    };
    this.hbTimer = setTimeout(hbLoop, 8000);
  }

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

  start() {
    if (!this.files.length) throw new Error('no files queued');
    if (this.mode === 'instant') return this.startInstant();
    this.startRealtime();
    return undefined;
  }

  stop() {
    this.stopped = true;
    this.done = true; // mark done too, otherwise /start and /status think it's still running
    if (this.timer) clearTimeout(this.timer);
    if (this.hbTimer) clearTimeout(this.hbTimer);
  }

  finish() {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.hbTimer) clearTimeout(this.hbTimer);
    this.onFinish(this);
  }

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
