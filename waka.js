// Env config, read once at require time: changing an env var on a running
// instance has no effect until the process restarts (redeploy on render).
// The base url is normalized (trailing slashes stripped) so the url joins
// below never produce "//users".
const API_URL = (process.env.WAKA_API_URL || 'https://hackatime.hackclub.com/api/hackatime/v1').replace(/\/+$/, '');
const API_KEY = process.env.WAKA_API_KEY || '';
// user segment in the heartbeat url — 'current' works on wakatime; hackatime
// may 404 on it, in which case set WAKA_USER to your hackatime username/id.
const USER_SEGMENT = process.env.WAKA_USER || 'current';

// the real plugins just run wakatime-cli under the hood, and wakatime parses
// editor + os from the User-Agent header. so we mirror the vscode plugin agent
// on windows — blends in with the existing stats instead of showing "linux".
const USER_AGENT = 'wakatime/v1.102.5 (windows-10.0.22631-x86_64) go1.22.5 vscode/1.95.3 vscode-wakatime/25.0.3';
// pinned to a real plugin release — don't bump these versions casually. if you
// update it, match an actual vscode-wakatime release (agent + plugin versions)
// so the beats stay indistinguishable from a genuine plugin install.

// Warn once, not per heartbeat: with no api key every beat fails, and
// logging each one would spam the render logs every ~2 min for the whole run.
let warnedMissingKey = false;
function warnMissingKey() {
  if (!warnedMissingKey) {
    warnedMissingKey = true;
    console.error('WAKA_API_KEY is not set — heartbeats will not be sent');
  }
}

// wakatime auth is just the api key base64'd as a Basic credential —
// the username part is unused, so the key itself goes through the encoder.
/**
 * Headers shared by every heartbeat POST: Basic auth from the api key,
 * the pinned vscode-plugin User-Agent, and JSON content type.
 *
 * @returns {object} Authorization, User-Agent and Content-Type headers
 */
function headers() {
  return {
    'Authorization': 'Basic ' + Buffer.from(API_KEY).toString('base64'),
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/json',
  };
}

/**
 * Single-shot heartbeat POST. Never throws — returns { ok } plus a status
 * code or error string, so the caller can keep its own sent/failed tallies.
 * The api key goes out twice on purpose: the Basic auth header above (the
 * wakatime-cli convention) and the api_key query param below — both servers
 * accept the param, so it works as a compat fallback if one path is rejected.
 * Returns { ok: false } immediately when WAKA_API_KEY is unset (and logs a
 * one-time warning the first time that happens, so the reason for a growing
 * "failed" count in /status is visible in the logs instead of silent).
 *
 * @param {object} hb heartbeat payload from makeHeartbeat()
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
async function sendHeartbeat(hb) {
  if (!API_KEY) {
    warnMissingKey();
    return { ok: false, error: 'missing WAKA_API_KEY' };
  }
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
 * failed tallies from the returned object. When WAKA_API_KEY is unset every
 * beat is counted failed up front, like sendHeartbeat's early return: the
 * tally is identical to firing the posts, but a long instant run no longer
 * spams the api with dozens of doomed requests first. The missing-key case
 * logs the same one-time warning as sendHeartbeat.
 *
 * @param {Array} hbs heartbeat payloads, in chronological order
 * @returns {Promise<{sent: number, failed: number}>}
 */
async function sendBulk(hbs) {
  if (!API_KEY) {
    warnMissingKey();
    return { sent: 0, failed: hbs.length };
  }
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
    // burst, so this keeps the bulk sync inside the api's rate limits. no
    // pause after the final chunk: the sync is over, nothing else is waiting.
    if (i + 25 < hbs.length) await new Promise((r) => setTimeout(r, 1200));
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
 * @returns {object} wakatime heartbeat payload (entity, type, category,
 *          time, project, lineno, cursorpos, lines, is_write)
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
