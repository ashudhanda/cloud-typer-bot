# cloud typer bot

a telegram bot that types your code in the cloud and logs wakatime/hackatime hours while your laptop stays off.

you give it code, tell it how long, and it:

- "types" the file char by char with human pacing (realtime mode)
- or backfills the hours in one shot (instant mode)
- sends heartbeats to hackatime/wakatime exactly like the vscode plugin does
- hands the finished file back to you on telegram

## setup (~10 min)

1. telegram → @BotFather → `/newbot` → copy the token
2. hackatime → settings → copy your api key (wakatime.com works too, see `WAKA_API_URL` below)
3. push this folder to a private github repo
4. render.com → new → web service → connect the repo
   - build command: `npm install`
   - start command: `npm start`
   - instance type: free
5. add env vars in render:

| var | value |
| --- | --- |
| `BOT_TOKEN` | the botfather token |
| `WAKA_API_KEY` | your hackatime/wakatime api key |
| `WAKA_API_URL` | `https://hackatime.hackclub.com/api/hackatime/v1` (default) — for wakatime.com use `https://wakatime.com/api/v1` |
| `OWNER_ID` | your telegram id — see step 7 |
| `DEFAULT_PROJECT` | optional default project name |

6. deploy, wait for it to go live
7. open your bot in telegram → `/id` → copy the number → set `OWNER_ID` in render → redeploy. this locks the bot so only you can use it
8. uptimerobot → new monitor → `https://your-app.onrender.com/health` → every 5 min (keeps the free instance awake)

## usage

1. send the bot a code file (or paste 200+ chars of code)
2. `/start` → pick duration → mode → speed → project → ▶ start
3. `/status` to watch progress, `/stop` to end early (partial file is sent), `/getfile` to grab the file anytime

file naming matters: the dashboard language comes from the extension, so `style.css` shows up as CSS, `app.js` as JavaScript. rename a pasted source with `/name style.css`.

## the two modes

**realtime** — runs live for the full duration. heartbeats go out throttled (~1 per 2 min plus "saves"), same cadence as the real vscode plugin. safest and most natural — this is the default choice.

**instant** — sends heartbeats covering the past N hours in one bulk sync. this is the same "offline sync" pattern the official plugins use when you code without internet and sync later. good as an occasional top-up. don't run it daily with huge numbers — keep your totals human (6–10h a day max).

## how the dashboard reads it

- language ← file extension of the entity path
- project ← the project you pick at launch
- editor/os ← we send the vscode-on-windows user agent, so it blends with your existing stats instead of showing a random linux box
- category ← plain `coding`, which counts as human coding, never ai

## rules

- realistic hours. 24h/day looks non-human on any system
- realtime by default, instant sparingly
- don't run copilot chat / claude code on the same tracked account mid-run

## troubleshooting

- bot silent → `OWNER_ID` wrong (check `/id`), or render logs show a polling error (bad token)
- heartbeats failing → check `WAKA_API_KEY` / `WAKA_API_URL` in render env; `/status` shows the failed count. if you see 404s on hackatime, set `WAKA_USER` to your hackatime username/id
- render sleeping → uptimerobot monitor on `/health`
- local test: `npm install`, copy `.env.example` to `.env`, fill it, `npm start`
