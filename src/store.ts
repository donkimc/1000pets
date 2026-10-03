// Append-only JSONL logs plus JSON snapshots, stored under DATA_DIR/runs/<runId>/.
// On Railway, DATA_DIR should point at a mounted volume (e.g. /data).
import { appendFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
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

  /** Last `limit` records of a log. Reads only the tail of the file, so large logs stay cheap. */
  async readLog<T = unknown>(log: LogName, limit = 200): Promise<T[]> {
    let fh;
    try {
      fh = await open(path.join(this.dir, `${log}.jsonl`), "r");
    } catch (e: any) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    try {
      const { size } = await fh.stat();
      let chunk = Math.min(size, Math.max(64 * 1024, limit * 1500));
      for (;;) {
        const buf = Buffer.alloc(chunk);
        await fh.read(buf, 0, chunk, size - chunk);
        let lines = buf.toString("utf8").split("\n");
        if (chunk < size) lines = lines.slice(1); // the first line may be cut in half
        lines = lines.filter(Boolean);
        if (lines.length >= limit || chunk >= size) return lines.slice(-limit).map((l) => JSON.parse(l) as T);
        chunk = Math.min(size, chunk * 4); // records were bigger than guessed: read more
      }
    } finally {
      await fh.close();
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
