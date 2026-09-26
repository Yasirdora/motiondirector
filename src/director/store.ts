import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Durable records, one JSON file each, so after a restart Motion Director can
 * still explain what happened: briefs, changes and motion styles.
 *
 * Kept outside the After Effects project folder (under ~/.motion-director by
 * default) so nothing here is ever sent along with the project or mixed up with
 * the designer's files. Writes are atomic: a crash leaves the old file or the
 * new one, never half of either.
 */
export type RecordKind = "briefs" | "changes" | "styles";

export function defaultRoot(): string {
  return process.env.MOTION_DIRECTOR_HOME || path.join(homedir(), ".motion-director");
}

/** One folder per After Effects project, keyed by its file path (or its name while unsaved). */
export function projectKey(projectPath: string | null, projectName: string): string {
  if (projectPath) return createHash("sha256").update(path.resolve(projectPath)).digest("hex").slice(0, 16);
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";
  return `unsaved-${slug}`;
}

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

export class Store {
  constructor(readonly root: string = defaultRoot()) {}

  write<T>(project: string, kind: RecordKind, id: string, value: T): void {
    const dir = this.dir(project, kind);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${checkId(id)}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
  }

  read<T>(project: string, kind: RecordKind, id: string): T | null {
    try {
      return JSON.parse(readFileSync(path.join(this.dir(project, kind), `${checkId(id)}.json`), "utf8")) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  list<T>(project: string, kind: RecordKind): T[] {
    let names: string[];
    try {
      names = readdirSync(this.dir(project, kind));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return names
      .filter((n) => n.endsWith(".json"))
      .sort()
      .map((n) => JSON.parse(readFileSync(path.join(this.dir(project, kind), n), "utf8")) as T);
  }

  private dir(project: string, kind: RecordKind): string {
    return path.join(this.root, "projects", checkId(project), kind);
  }
}

/** Ids become file names; refuse anything that could step outside the store. */
function checkId(id: string): string {
  if (!SAFE_ID.test(id) || id === "." || id === "..") throw new Error(`Unsafe record id: ${JSON.stringify(id)}`);
  return id;
}
