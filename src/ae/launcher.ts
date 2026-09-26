/**
 * How the dispatcher gets into a running After Effects, per platform.
 *
 * macOS: AppleScript's DoScript through `osascript`, carrying a two-line
 * bootstrap that pins the mailbox path and evaluates the dispatcher. The exit
 * code is meaningful: -1743 means the Automation permission was denied, which
 * is reported in seconds instead of as a timeout. (Approach learned from
 * kumo's mcp-aftereffects, MIT.)
 *
 * Windows: `AfterFX.exe -r dispatcher.jsx`. Fire and forget; the exit code says
 * nothing, and the dispatcher finds the mailbox by the shared temp-folder
 * convention because `-r` cannot pass data.
 */
export interface LaunchPlan {
  command: string;
  args: string[];
  /** Watch stderr and the exit code for a fast diagnosis (osascript only). */
  diagnoseExit: boolean;
}

function jsxString(value: string): string {
  return `'${value.replace(/\\/g, "/").replace(/'/g, "\\'")}'`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** AppleScript addresses the application bundle, not the binary inside it. */
function appBundle(aePath: string): string {
  const match = aePath.replace(/\\/g, "/").match(/^(.*?\.app)(\/|$)/);
  return match ? (match[1] as string) : aePath;
}

export function buildLaunchPlan(
  aePath: string,
  dispatcherPath: string,
  mailbox: string,
  platform: NodeJS.Platform = process.platform,
): LaunchPlan {
  if (platform === "darwin") {
    const bootstrap = `$.global.MOTION_DIRECTOR_MAILBOX = ${jsxString(mailbox)}; $.evalFile(${jsxString(dispatcherPath)});`;
    return {
      command: "/usr/bin/osascript",
      args: [
        // DoScript blocks osascript until the script returns; lift AppleScript's
        // two-minute default well past any operation's own timeout.
        "-e",
        "with timeout of 7200 seconds",
        "-e",
        `tell application ${appleScriptString(appBundle(aePath))} to DoScript ${appleScriptString(bootstrap)}`,
        "-e",
        "end timeout",
      ],
      diagnoseExit: true,
    };
  }
  return { command: aePath, args: ["-r", dispatcherPath], diagnoseExit: false };
}
