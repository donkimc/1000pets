// Takes the pictures used in README.md: the site's tabs, the 3D view from several cameras, and portraits of the cast.
//
//   1. start a server you do not mind changing (its own RUN_ID and DATA_DIR) and let it run until it is daytime
//   2. URL=http://localhost:3300 CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npx tsx scripts/screenshots.ts
//
// It uses the Chrome you already have (puppeteer-core downloads nothing). Pictures go to docs/screenshots/.
import puppeteer, { type Page } from "puppeteer-core";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const URL_ = process.env.URL ?? "http://localhost:3300";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = path.join(import.meta.dirname ?? ".", "..", "docs", "screenshots");
mkdirSync(OUT, { recursive: true });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (p: string, body: unknown) => fetch(URL_ + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ["--no-sandbox", "--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--hide-scrollbars"], // the graphics chip draws the 3D view; software drawing takes minutes per picture
});

async function open(width: number, height: number, scale = 2): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: scale });
  await page.goto(URL_ + "/?fps=10", { waitUntil: "networkidle2" });
  await page.evaluate(() => localStorage.setItem("minimap", "1"));
  await wait(2500);
  return page;
}
const tab = async (page: Page, name: string) => { await page.evaluate((n) => (document.querySelector(`[data-go="${n}"]`) as HTMLElement).click(), name); await wait(2500); };
const shot = async (page: Page, file: string, el?: string) => {
  const target = el ? await page.$(el) : null;
  if (el && !target) throw new Error("no element " + el);
  await (target ?? page).screenshot({ path: path.join(OUT, file) as `${string}.png`, ...(target ? {} : { fullPage: false }) });
  console.log("wrote", file);
};

// ---- desktop: the Live tab, 3D beside the map ----
const SCALE = Number(process.env.SCALE ?? 1);
const desk = await open(1280, 900, SCALE);
await tab(desk, "live");
await desk.evaluate(() => (window as any).world3d.setMode("walk"));
// stand the human in the living room facing the room
await desk.evaluate(() => (window as any).__app.walkTo({ x: 780, y: 520 }));
await wait(9000);
await desk.evaluate(() => { const w = (window as any).world3d; w.view.yaw = -2.4; w.view.pitch = -0.2; w.view.haveYaw = true; });
await wait(1200);
await shot(desk, "live-desktop.png");
await shot(desk, "3d-walk.png", "#view3d");

for (const [mode, file] of [["top", "3d-top.png"], ["pet", "3d-pet-eyes.png"], ["follow", "3d-follow.png"]] as const) {
  await desk.evaluate((m) => (window as any).world3d.setMode(m), mode);
  await wait(1500);
  await shot(desk, file, "#view3d");
}
await shot(desk, "map.png", "#map");

// ---- portraits of the cast ----
await desk.setViewport({ width: 520, height: 900, deviceScaleFactor: SCALE });
await desk.addStyleTag({ content: "#minimap,#pad,#ptt3d,#mm-big,#mm-hide,#mm-show,#view-note,#tabs{display:none!important}" }); // just the picture
await desk.evaluate(() => { document.getElementById("view3d")!.style.cssText = "aspect-ratio:1/1;width:100%;touch-action:none"; });
const cast: { key: string; name: string; file: string }[] = [];
const pets: { id: string; name: string }[] = await desk.evaluate(() => (window as any).__app.state.pets.map((p: any) => ({ id: p.id, name: p.name })));
for (const p of pets) cast.push({ key: "pet:" + p.id, name: p.name, file: `cast-${p.id}.png` });
cast.push({ key: "teacher", name: "Teacher", file: "cast-teacher.png" });
for (const c of cast) {
  await desk.evaluate((k) => (window as any).world3d.portrait(k), c.key);
  await wait(1200);
  await desk.evaluate(() => document.getElementById("view3d")!.scrollIntoView());
  await shot(desk, c.file, "#view3d");
}
await desk.close();

// ---- the cast on one picture ----
const group = await browser.newPage();
await group.setViewport({ width: 1600, height: 440, deviceScaleFactor: 1 });
const imgs = cast.map((c) => `data:image/png;base64,${readFileSync(path.join(OUT, c.file)).toString("base64")}`);
await group.setContent(`<body style="margin:0;background:#101418;font:600 22px system-ui;color:#e8edf2;display:flex;gap:12px;padding:12px">${cast.map((c, i) => `<div style="flex:1;text-align:center"><img src="${imgs[i]}" style="width:100%;border-radius:12px;display:block">${c.name}</div>`).join("")}</body>`);
await wait(500);
await group.screenshot({ path: path.join(OUT, "cast.png") as `${string}.png`, fullPage: true });
console.log("wrote cast.png");
await group.close();

// ---- phone: the other tabs ----
const phone = await open(430, 932, 2); // (no 3D drawing on these tabs, so full sharpness is cheap)
const pageShot = async (name: string, file: string, el?: string) => { await tab(phone, name); await shot(phone, file, el); };
await tab(phone, "live"); await shot(phone, "phone-live.png");
await pageShot("talk", "talk.png");
await pageShot("env", "env.png");
await tab(phone, "teacher");
for (const [id, file] of [["t-long", "teacher-plan.png"], ["t-agenda", "teacher-agenda.png"]] as const) {
  const sec = await phone.evaluateHandle((i) => document.getElementById(i)!.closest("section")!, id);
  await (sec.asElement() as any).screenshot({ path: path.join(OUT, file) }); console.log("wrote", file);
}
await pageShot("saves", "saves.png");
// a pet's mind, opened
await tab(phone, "pets");
await phone.evaluate(() => (document.querySelector('button[data-id="pip"]') as HTMLElement).click());
await wait(3500);
const card = await phone.evaluateHandle(() => { let e: HTMLElement | null = document.querySelector('button[data-id="pip"]'); while (e && !e.className.includes("rounded-xl") && !e.className.includes("rounded-lg")) e = e.parentElement; return e!; });
await phone.evaluate(() => (window as any).scrollTo(0, 0));
// the top of the card, down to the end of the pet's own map (the rest of the card is a long list)
const cb = await (card.asElement() as any).boundingBox();
const mapEl = await phone.$('[data-f="mind"] svg[aria-label="The places this pet knows"]');
const mb = mapEl ? await mapEl.boundingBox() : null;
await phone.screenshot({ path: path.join(OUT, "pets-card.png") as `${string}.png`, captureBeyondViewport: true, clip: { x: cb.x, y: cb.y, width: cb.width, height: mb ? mb.y + mb.height + 70 - cb.y : 1800 } });
console.log("wrote pets-card.png");
// the dashboard, in pieces
await tab(phone, "dash");
await wait(3000);
await shot(phone, "dashboard-top.png");
for (const [id, file] of [["room-now", "dash-rooms.png"], ["room-time", "dash-time.png"], ["room-strip", "dash-strip.png"], ["activity", "dash-activity.png"]] as const) {
  const ok = await phone.$("#" + id);
  if (ok) { await ok.evaluate((e) => e.scrollIntoView()); await wait(300); const sec = await phone.evaluateHandle((i) => document.getElementById(i)!.closest("section")!, id); await (sec.asElement() as any).screenshot({ path: path.join(OUT, file) }); console.log("wrote", file); }
}
await browser.close();
