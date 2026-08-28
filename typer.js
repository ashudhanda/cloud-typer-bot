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
    this.content = String(opts.content || '').replace(/\r\n/g, '\n');
    this.fileName = opts.fileName || 'code.txt';
    this.project = opts.project || process.env.DEFAULT_PROJECT || 'myproject';
    this.durationMin = opts.durationMin;
    this.mode = opts.mode; // 'realtime' | 'instant'
    this.speed = SPEED_PROFILES[opts.speed] || SPEED_PROFILES.normal;
    this.index = 0;
    this.heartbeatsSent = 0;
    this.heartbeatsFailed = 0;
    this.startedAt = Date.now();
    this.done = false;
    this.stopped = false;
    this.timer = null;
    this.hbTimer = null;
    this.onFinish = opts.onFinish || (() => {});
    this.outPath = path.join(OUT_DIR, `${Date.now()}-${this.fileName}`);
    // windows-style entity path so stats look like they came from the same machine
    this.entity = `C:\\Users\\WELCOME\\${this.project}\\${this.fileName}`;

    // newline offsets for lineno/cursorpos math
    this.lineStarts = [0];
    for (let i = 0; i < this.content.length; i++) {
      if (this.content[i] === '\n') this.lineStarts.push(i + 1);
    }
    this.totalLines = this.lineStarts.length;
  }

  lineInfo(idx) {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.lineStarts[mid] <= idx) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return { lineno: ans + 1, cursorpos: idx - this.lineStarts[ans] + 1 };
  }

  heartbeat(isWrite, timeOverride, idxOverride) {
    const idx = idxOverride !== undefined ? idxOverride : this.index;
    const clamped = Math.max(0, Math.min(idx, this.content.length));
    const { lineno, cursorpos } = this.lineInfo(clamped);
    return waka.makeHeartbeat({
      entity: this.entity,
      project: this.project,
      time: timeOverride !== undefined ? timeOverride : Date.now() / 1000,
      lineno,
      cursorpos,
      lines: this.totalLines,
      isWrite,
    });
  }

  async fireHeartbeat(isWrite) {
    const res = await waka.sendHeartbeat(this.heartbeat(isWrite));
    if (res.ok) this.heartbeatsSent += 1;
    else {
      this.heartbeatsFailed += 1;
      if (res.status) console.error('heartbeat failed:', res.status);
    }
  }

  startRealtime() {
    const totalChars = this.content.length;
    const totalMs = this.durationMin * 60 * 1000;
    const baseDelay = Math.max(20, (totalMs / Math.max(1, totalChars)) * this.speed.pace);

    const step = () => {
      if (this.stopped || this.done) return;
      // small bursts of 1-4 chars feel more like a person than a fixed metronome
      const burst = Math.min(1 + Math.floor(rand(0, 3.2)), totalChars - this.index);
      if (burst > 0) {
        fs.appendFileSync(this.outPath, this.content.slice(this.index, this.index + burst));
        this.index += burst;
      }
      if (this.index >= totalChars) {
        this.finish();
        return;
      }
      let delay = baseDelay * burst * rand(0.45, 1.6);
      if (this.content[this.index - 1] === '\n') delay += rand(250, 1400); // end-of-line pause
      if (Math.random() < 0.006) delay += rand(2500, 9000); // occasional thinking pause
      this.timer = setTimeout(step, delay);
    };
    this.timer = setTimeout(step, 500);

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
    let t = start;
    let i = 0;
    while (t < now) {
      const frac = (t - start) / (now - start);
      const idx = Math.floor(frac * this.content.length);
      beats.push(this.heartbeat(i % 15 === 14, t, idx)); // every 15th = save
      i += 1;
      t += rand(100, 135); // one beat every ~2 min, same cadence as a throttled plugin
    }
    beats.push(this.heartbeat(true, now, this.content.length)); // final save

    const res = await waka.sendBulk(beats);
    this.heartbeatsSent = res.sent;
    this.heartbeatsFailed = res.failed;
    this.index = this.content.length;
    fs.writeFileSync(this.outPath, this.content);
    this.finish();
  }

  start() {
    fs.writeFileSync(this.outPath, '');
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
    if (this.mode === 'realtime') this.fireHeartbeat(true); // final save
    this.onFinish(this);
  }

  status() {
    const pct = this.content.length ? (this.index / this.content.length) * 100 : 100;
    const elapsedMin = (Date.now() - this.startedAt) / 60000;
    const etaMin = this.mode === 'instant' ? 0 : Math.max(0, this.durationMin - elapsedMin);
    return {
      stopped: this.stopped,
      percent: pct.toFixed(1),
      charsDone: this.index,
      charsTotal: this.content.length,
      elapsedMin: elapsedMin.toFixed(1),
      etaMin: etaMin.toFixed(0),
      heartbeatsSent: this.heartbeatsSent,
      heartbeatsFailed: this.heartbeatsFailed,
      done: this.done,
      mode: this.mode,
      fileName: this.fileName,
      project: this.project,
    };
  }
}

module.exports = { TyperRun, OUT_DIR };
