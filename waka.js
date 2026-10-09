// these are read once at require time — changing an env var on a running
// instance has no effect until the process restarts (redeploy on render).
// normalize trailing slashes so the url joins below never produce "//users".
const API_URL = (process.env.WAKA_API_URL || 'https://hackatime.hackclub.com/api/hackatime/v1').replace(/\/+$/, '');
const API_KEY = process.env.WAKA_API_KEY || '';
// user segment in the heartbeat url — 'current' works on wakatime; hackatime
// may 404 on it, in which case set WAKA_USER to your hackatime username/id.
const USER_SEGMENT = process.env.WAKA_USER || 'current';

// the real plugins just run wakatime-cli under the hood, and wakatime parses
// editor + os from the User-Agent header. so we mirror the vscode plugin agent
// on windows — blends in with the existing stats instead of showing "linux".
const USER_AGENT = 'wakatime/v1.102.5 (windows-10.0.22631-x86_64) go1.22.5 vscode/1.95.3 vscode-wakatime/25.0.3';

// wakatime auth is just the api key base64'd as a Basic credential —
// the username part is unused, so the key itself goes through the encoder.
function headers() {
  return {
    'Authorization': 'Basic ' + Buffer.from(API_KEY).toString('base64'),
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/json',
  };
}

// Single-shot heartbeat POST. Never throws — returns { ok } plus a status
// code or error string, so the caller can keep its own sent/failed tallies.
async function sendHeartbeat(hb) {
  if (!API_KEY) return { ok: false, error: 'missing WAKA_API_KEY' };
  try {
    const res = await fetch(`${API_URL}/users/${USER_SEGMENT}/heartbeats?api_key=${API_KEY}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(hb),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Bulk-sync heartbeats in one shot (instant mode). The api accepts at most
 * 25 heartbeats per bulk post, so long runs are sliced into chunks; the 1.2s
 * pause between chunks keeps the burst inside the api's rate limits. Chunk
 * failures are counted per heartbeat, never thrown — the run reports sent /
 * failed tallies from the returned object.
 *
 * @param {Array} hbs heartbeat payloads, in chronological order
 * @returns {Promise<{sent: number, failed: number}>}
 */
async function sendBulk(hbs) {
  const results = { sent: 0, failed: 0 };
  for (let i = 0; i < hbs.length; i += 25) {
    const chunk = hbs.slice(i, i + 25);
    try {
      const res = await fetch(`${API_URL}/users/${USER_SEGMENT}/heartbeats.bulk?api_key=${API_KEY}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(chunk),
      });
      if (res.ok) results.sent += chunk.length;
      else {
        results.failed += chunk.length;
        console.error('bulk heartbeat failed:', res.status, await res.text().catch(() => ''));
      }
    } catch (err) {
      results.failed += chunk.length;
      console.error('bulk heartbeat error:', String(err));
    }
    // 1.2s pause between chunks — instant mode can fire dozens of posts in a
    // burst, so this keeps the bulk sync inside the api's rate limits.
    await new Promise((r) => setTimeout(r, 1200));
  }
  return results;
}

/**
 * Shape a wakatime-compatible heartbeat payload. entity is the (spoofed) file
 * path, category 'coding' counts as human coding on the dashboard, time is
 * unix seconds, and is_write marks a file save rather than passive editing.
 *
 * @param {string} entity    file path shown on the dashboard
 * @param {string} project   project name the heartbeat is filed under
 * @param {number} time      unix timestamp in seconds
 * @param {number} lineno    1-based line of the cursor
 * @param {number} cursorpos 1-based cursor column
 * @param {number} lines     total lines in the file
 * @param {boolean} isWrite  true = file save, false = passive editing
 */
function makeHeartbeat({ entity, project, time, lineno, cursorpos, lines, isWrite }) {
  return {
    entity,
    type: 'file',
    category: 'coding', // plain coding = human coding on the dashboard, never ai
    time,
    project,
    lineno,
    cursorpos,
    lines,
    is_write: !!isWrite,
  };
}

module.exports = { sendHeartbeat, sendBulk, makeHeartbeat };
