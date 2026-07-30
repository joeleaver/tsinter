import { buildTargetPlatform } from "@tsinter/compiler";

/** Default executable filename for the build target. Explicit --out paths
 * stay exact; only scriptc's generated default needs the Windows PE suffix. */
export function defaultExecutableName(stem: string, platform: string = buildTargetPlatform()): string {
  return platform === "win32" ? `${stem}.exe` : stem;
}
