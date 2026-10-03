// Append-only JSONL logs plus JSON snapshots, stored under DATA_DIR/runs/<runId>/.
// On Railway, DATA_DIR should point at a mounted volume (e.g. /data).
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type LogName = "events" | "comms" | "world" | string; // string allows "thoughts/<pet>"

export class Store {
  constructor(readonly dir: string) {}

  static async open(dataDir: string, runId: string): Promise<Store> {
    const dir = path.join(dataDir, "runs", runId);
    await mkdir(path.join(dir, "thoughts"), { recursive: true });
    await mkdir(path.join(dir, "snapshots"), { recursive: true });
    return new Store(dir);
  }

  async append(log: LogName, record: unknown): Promise<void> {
    await appendFile(path.join(this.dir, `${log}.jsonl`), JSON.stringify(record) + "\n");
  }

  async readLog<T = unknown>(log: LogName, limit = 200): Promise<T[]> {
    try {
      const text = await readFile(path.join(this.dir, `${log}.jsonl`), "utf8");
      const lines = text.split("\n").filter(Boolean);
      return lines.slice(-limit).map((l) => JSON.parse(l) as T);
    } catch (e: any) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }

  async writeJson(file: string, value: unknown): Promise<void> {
    await writeFile(path.join(this.dir, file), JSON.stringify(value, null, 2));
  }

  async readJson<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path.join(this.dir, file), "utf8")) as T;
    } catch (e: any) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
}
