# Handoff: running 1000pets locally

## Get the code and run it
```bash
git clone https://github.com/donkimc/1000pets.git
cd 1000pets
npm install
npm test            # 41 tests
GROQ_API_KEY=... DEEPSEEK_API_KEY=... npm run dev     # http://localhost:3000
```
Node 20 or newer (built on Node 22). Without API keys the world, pets, chat gate and dashboard still run,
but System 2 (slow thinking) and pet replies are off.

Production build, as Railway runs it: `npm run build && npm start`.

## Environment variables
| Name | Default | Purpose |
|---|---|---|
| `GROQ_API_KEY` | none | Primary thinking model (`openai/gpt-oss-120b`, free tier) |
| `DEEPSEEK_API_KEY` | none | Fallback model (`deepseek-chat`) |
| `DEEPSEEK_BUDGET_USD` | 4 | DeepSeek is skipped once estimated spend reaches this |
| `GROQ_MODEL`, `DEEPSEEK_MODEL` | see above | Override the models |
| `S2_INTERVAL_SEC` | 70 | Real seconds between a pet's slow thoughts (randomised 0.8-1.3x) |
| `DATA_DIR` | `./data` | Where JSON logs and snapshots are written (`/data` volume on Railway) |
| `SEED` | 12345 | World and pet random seed |
| `RUN_ID` | main | Folder name under `DATA_DIR/runs/` |
| `ADMIN_TOKEN` | none | If set, speed/pause/add-pet endpoints need header `x-admin-token` (the page has no field for it yet) |

Never commit keys. On Railway they are service variables on the `1000pets` project.

## Hosting
Railway project `1000pets` deploys `main` automatically. A volume `1000pets-data` is mounted at `/data`.
Live URL: https://1000pets-production.up.railway.app

## Layout
- `src/clock.ts` simulation clock (1x, 10x, 100x, 1000x), independent of wall time
- `src/world.ts` room, sun, weather, temperature, curtain, door, lamp, heater, noises
- `src/sim.ts` advances world and pets in fixed 5 s chunks (deterministic for a seed)
- `src/sensors.ts` virtual sensors; pets never read world state directly
- `src/system1.ts` fast rule-based decisions and drives; `src/system2.ts` slow LLM thinking
- `src/llm.ts` Groq first, DeepSeek fallback, honours rate-limit replies, tracks spend
- `src/speech.ts`, `src/conversation.ts` spatial speech, claims, System 1 speaking gate
- `src/server.ts` HTTP, WebSocket and APIs; `public/` is the mobile site (Tailwind, built to `public/app.css`)
- `config/pets.json` pet names, colours, traits (source of truth, applied at every start)
- `AGENT.md`, `README.md` the original concept and design rules

## Done so far
Phases 1-7: scaffold and deploy, 2D world and environment, three pets with sensors and System 1,
human avatar, System 2 thinking, speech and chat, tabbed UI with dashboard.

## Not done
- Phase 8: one-tap 30-day accelerated run with progress and a summary report
- Prediction and prediction error, curiosity from surprise, verifying claims, trust between pets
- Pet recognition as persistent entities, relationship state
- An "add pet" form (the `POST /api/pets` endpoint exists)
- Optional System 1 deciders (Laya, Jev) behind a `Decider` interface were discussed, not built

## Things to know
- Groq free tier limits (daily tokens) are enforced by Groq; the gateway backs off on its 429 and uses DeepSeek.
- The human avatar moves in real time, not simulated time.
- Pet speech rates are constants in `src/speech.ts` (`GATE`, voice ranges).
- Test servers in `/tmp` used a fake OpenAI-style provider; the real models have only been seen answering System 2 thoughts.
