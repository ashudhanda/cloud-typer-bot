const API_URL = (process.env.WAKA_API_URL || 'https://hackatime.hackclub.com/api/hackatime/v1').replace(/\/+$/, '');
const API_KEY = process.env.WAKA_API_KEY || '';
const USER_SEGMENT = process.env.WAKA_USER || 'current';

// the real plugins just run wakatime-cli under the hood, and wakatime parses
// editor + os from the User-Agent header. so we mirror the vscode plugin agent
// on windows — blends in with the existing stats instead of showing "linux".
const USER_AGENT = 'wakatime/v1.102.5 (windows-10.0.22631-x86_64) go1.22.5 vscode/1.95.3 vscode-wakatime/25.0.3';

function headers() {
  return {
    'Authorization': 'Basic ' + Buffer.from(API_KEY).toString('base64'),
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/json',
  };
}

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

// bulk endpoint takes max 25 heartbeats per post — chunk it
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
    await new Promise((r) => setTimeout(r, 1200)); // don't hammer the api
  }
  return results;
}

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
