import { existsSync } from "node:fs";
import path from "node:path";

/** Newest first: the version most people have open. */
const VERSIONS = ["2026", "2025", "2024"];

export class AfterEffectsNotFound extends Error {}

/**
 * Where After Effects lives. `MOTION_DIRECTOR_AE` overrides the search, and
 * accepts either the .app bundle or the executable inside it on macOS.
 */
export function locateAfterEffects(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): string {
  const override = env.MOTION_DIRECTOR_AE;
  if (override) {
    if (exists(override)) return override;
    throw new AfterEffectsNotFound(`MOTION_DIRECTOR_AE points at ${override}, which does not exist.`);
  }
  const candidates =
    platform === "darwin"
      ? VERSIONS.map((v) => `/Applications/Adobe After Effects ${v}/Adobe After Effects ${v}.app`)
      : platform === "win32"
        ? VERSIONS.map((v) =>
            path.win32.join(env.ProgramFiles ?? "C:\\Program Files", "Adobe", `Adobe After Effects ${v}`, "Support Files", "AfterFX.exe"),
          )
        : [];
  const found = candidates.find((c) => exists(c));
  if (found) return found;
  if (platform !== "darwin" && platform !== "win32") {
    throw new AfterEffectsNotFound("After Effects only runs on macOS and Windows.");
  }
  throw new AfterEffectsNotFound(
    `After Effects ${VERSIONS.join(", ")} was not found in the usual place. Set MOTION_DIRECTOR_AE to where it is installed.`,
  );
}
