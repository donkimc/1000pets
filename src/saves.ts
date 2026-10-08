// Named snapshots of a whole simulation run. A save is a copy of the run folder (clock, world, pets, teacher,
// logs, thoughts) plus a small meta.json for the list. Loading copies it back over the live run folder.
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip), gunzipAsync = promisify(gunzip);

export interface SaveMeta {
  id: string;
  name: string;
  createdAt: string; // ISO wall-clock time
  simDay: number;
  simTime: string; // "D3 14:05"
  speed: number;
  pets: string[];
  auto: boolean; // an automatic backup made just before a load
  bytes: number;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
export const AUTO_BACKUPS_KEPT = 3;
export const BUNDLE_FORMAT = "1000pets-save";
export const BUNDLE_MAX_BYTES = 400 * 1024 * 1024; // the most an uploaded save may expand to
const FILE_RE = /^(?:[a-z0-9_-]{1,40}\/){0,2}[A-Za-z0-9][A-Za-z0-9_.-]{0,59}\.jsonl?$/; // a log or state file, at most two folders down, nothing that climbs out
const PET_ID_RE = /^[a-z0-9_-]{1,32}$/;

async function walk(dir: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, base), { withFileTypes: true }).catch(() => [])) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(dir, rel)));
    else out.push(rel);
  }
  return out;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "save";

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? await dirBytes(p) : (await stat(p).catch(() => null))?.size ?? 0;
  }
  return total;
}

export class Saves {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "saves");
  }

  static validId(id: string): boolean {
    return ID_RE.test(id);
  }

  private path(id: string) {
    if (!Saves.validId(id)) throw new Error("bad save id");
    return path.join(this.dir, id);
  }

  async list(): Promise<SaveMeta[]> {
    const out: SaveMeta[] = [];
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      try {
        out.push(JSON.parse(await readFile(path.join(this.dir, name, "meta.json"), "utf8")) as SaveMeta);
      } catch {
        /* a half-written or foreign folder: ignore it */
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<SaveMeta | null> {
    try {
      return JSON.parse(await readFile(path.join(this.path(id), "meta.json"), "utf8")) as SaveMeta;
    } catch {
      return null;
    }
  }

  /** Copy the run folder into a new save. The caller flushes its in-memory state to the run folder first. */
  async create(runDir: string, name: string, info: Omit<SaveMeta, "id" | "name" | "createdAt" | "bytes" | "auto">, auto = false): Promise<SaveMeta> {
    await mkdir(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    let id = `${stamp}-${slug(name)}`;
    for (let i = 2; await this.get(id); i++) id = `${stamp}-${slug(name)}-${i}`;
    const tmp = path.join(this.dir, `.${id}.partial`);
    await rm(tmp, { recursive: true, force: true });
    await cp(runDir, path.join(tmp, "run"), { recursive: true, filter: (src) => !src.endsWith(".tmp") });
    const meta: SaveMeta = { id, name: name.slice(0, 60), createdAt: new Date().toISOString(), ...info, auto, bytes: await dirBytes(path.join(tmp, "run")) };
    await writeFile(path.join(tmp, "meta.json"), JSON.stringify(meta, null, 2));
    await rename(tmp, this.path(id)); // appears in the list only once it is complete
    if (auto) await this.pruneAuto();
    return meta;
  }

  /** A save as one file: everything in it (clock, world, pets, teacher, logs, thoughts) in a gzipped bundle, to keep or move to another machine. */
  async exportBundle(id: string): Promise<Buffer> {
    const meta = await this.get(id);
    if (!meta) throw new Error("no such save");
    const run = path.join(this.path(id), "run");
    const files: { path: string; data: string }[] = [];
    for (const rel of await walk(run)) {
      if (!FILE_RE.test(rel)) continue; // (leftover temp files and anything unexpected stay behind)
      files.push({ path: rel, data: await readFile(path.join(run, rel), "utf8") });
    }
    return gzipAsync(Buffer.from(JSON.stringify({ format: BUNDLE_FORMAT, version: 1, exportedAt: new Date().toISOString(), meta, files })));
  }

  /** Turn an uploaded bundle into a new save in the list (it does not touch the live simulation). Anything wrong with it is refused before a byte is kept. */
  async importBundle(buf: Buffer, fallbackName = "Uploaded save"): Promise<SaveMeta> {
    let b: any;
    try {
      b = JSON.parse((await gunzipAsync(buf, { maxOutputLength: BUNDLE_MAX_BYTES })).toString("utf8"));
    } catch {
      throw new Error("that is not a 1000pets save file");
    }
    if (!b || b.format !== BUNDLE_FORMAT || b.version !== 1 || !Array.isArray(b.files)) throw new Error("that is not a 1000pets save file");
    if (b.files.length > 400) throw new Error("the save file has too many files");
    const seen = new Map<string, string>();
    for (const f of b.files) {
      if (!f || typeof f.path !== "string" || typeof f.data !== "string" || !FILE_RE.test(f.path) || f.path.includes("..")) throw new Error(`the save file holds something unexpected (${String(f?.path).slice(0, 40)})`);
      if (seen.has(f.path)) throw new Error("the save file lists a file twice");
      seen.set(f.path, f.data);
    }
    const json = (name: string) => {
      const text = seen.get(name);
      if (text === undefined) throw new Error(`the save file is missing ${name}`);
      try { return JSON.parse(text); } catch { throw new Error(`${name} in the save file is damaged`); }
    };
    const clock = json("clock.json"), world = json("world.json"), pets = json("pets.json");
    if (!Number.isFinite(clock?.simMs) || !world || typeof world.env !== "object" || !Number.isFinite(world.simMinute) || !Array.isArray(pets?.pets) || !pets.pets.length || !pets.pets.every((p: any) => typeof p?.id === "string" && PET_ID_RE.test(p.id))) throw new Error("the save file does not hold a simulation I can read");
    for (const [name, text] of seen) if (name.endsWith(".json") && !["clock.json", "world.json", "pets.json"].includes(name)) { try { JSON.parse(text); } catch { throw new Error(`${name} in the save file is damaged`); } }
    const m = b.meta ?? {};
    const name = `${String(m.name ?? fallbackName).slice(0, 44)} (uploaded)`;
    await mkdir(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    let id = `${stamp}-${slug(name)}`;
    for (let i = 2; await this.get(id); i++) id = `${stamp}-${slug(name)}-${i}`;
    const tmp = path.join(this.dir, `.${id}.partial`);
    await rm(tmp, { recursive: true, force: true });
    for (const [rel, text] of seen) {
      await mkdir(path.dirname(path.join(tmp, "run", rel)), { recursive: true });
      await writeFile(path.join(tmp, "run", rel), text);
    }
    await mkdir(path.join(tmp, "run", "thoughts"), { recursive: true });
    await mkdir(path.join(tmp, "run", "snapshots"), { recursive: true });
    const meta: SaveMeta = {
      id, name: name.slice(0, 60), createdAt: new Date().toISOString(),
      simDay: Number.isFinite(m.simDay) ? Math.max(1, Math.round(m.simDay)) : Math.floor(clock.simMs / 86_400_000) + 1,
      simTime: typeof m.simTime === "string" ? m.simTime.slice(0, 12) : "", speed: Number.isFinite(clock.speed) ? clock.speed : 1,
      pets: Array.isArray(m.pets) ? m.pets.slice(0, 12).map((x: unknown) => String(x).slice(0, 30)) : pets.pets.map((p: any) => String(p.name ?? p.id).slice(0, 30)),
      auto: false, bytes: await dirBytes(path.join(tmp, "run")),
    };
    await writeFile(path.join(tmp, "meta.json"), JSON.stringify(meta, null, 2));
    await rename(tmp, this.path(id));
    return meta;
  }

  /** Replace the contents of the run folder with a save's. */
  async restore(id: string, runDir: string): Promise<SaveMeta> {
    const meta = await this.get(id);
    if (!meta) throw new Error("no such save");
    const src = path.join(this.path(id), "run");
    for (const e of await readdir(runDir).catch(() => [] as string[])) await rm(path.join(runDir, e), { recursive: true, force: true });
    await cp(src, runDir, { recursive: true });
    await mkdir(path.join(runDir, "thoughts"), { recursive: true });
    await mkdir(path.join(runDir, "snapshots"), { recursive: true });
    return meta;
  }

  async remove(id: string): Promise<void> {
    if (!(await this.get(id))) throw new Error("no such save");
    await rm(this.path(id), { recursive: true, force: true });
  }

  async rename(id: string, name: string): Promise<SaveMeta> {
    const meta = await this.get(id);
    if (!meta) throw new Error("no such save");
    meta.name = name.slice(0, 60);
    await writeFile(path.join(this.path(id), "meta.json"), JSON.stringify(meta, null, 2));
    return meta;
  }

  private async pruneAuto() {
    const autos = (await this.list()).filter((m) => m.auto);
    for (const m of autos.slice(AUTO_BACKUPS_KEPT)) await rm(this.path(m.id), { recursive: true, force: true });
  }
}

/** The brain library: one JSON file per saved brain under DATA_DIR/brains. */
export class BrainLibrary {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "brains");
  }

  async list(): Promise<{ id: string; petId: string; name: string; label: string; savedAt: string; simDay: number; bytes: number }[]> {
    const out = [];
    for (const f of await readdir(this.dir).catch(() => [] as string[])) {
      if (!f.endsWith(".json")) continue;
      try {
        const file = path.join(this.dir, f);
        const b = JSON.parse(await readFile(file, "utf8"));
        out.push({ id: f.slice(0, -5), petId: String(b.id), name: String(b.name), label: String(b.label ?? b.name), savedAt: String(b.savedAt ?? ""), simDay: Number(b.simDay) || 1, bytes: (await stat(file)).size });
      } catch {
        /* ignore unreadable files */
      }
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  async save(brain: { id: string; label: string }, json: unknown): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    let id = `${stamp}-${slug(brain.id)}-${slug(brain.label)}`.slice(0, 80);
    for (let i = 2; await this.read(id).catch(() => null); i++) id = `${id.replace(/-\d+$/, "")}-${i}`;
    const tmp = path.join(this.dir, `.${id}.tmp`);
    await writeFile(tmp, JSON.stringify(json));
    await rename(tmp, path.join(this.dir, `${id}.json`));
    return id;
  }

  async read(id: string): Promise<unknown> {
    if (!ID_RE.test(id)) throw new Error("bad brain id");
    return JSON.parse(await readFile(path.join(this.dir, `${id}.json`), "utf8"));
  }

  async remove(id: string): Promise<void> {
    if (!ID_RE.test(id)) throw new Error("bad brain id");
    await rm(path.join(this.dir, `${id}.json`));
  }
}
