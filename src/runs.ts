// Running OpenCode, one import for the chat layer. The work lives in:
//   run-cli.ts         `opencode run` — cold or attached (`--attach`)
//   run-server.ts      the warm server: POST + SSE
//   run-steps.ts       events → StepRecord, deltas, model, subagent spend
//   asks.ts            headless asks for a session and its subagents
//   server-session.ts  ids, permission rules, busy/abort, create, compact
// This module keeps what needs both runners: the stale-session retry.
import * as vscode from "vscode";
import { logChannel, stamp } from "./core";
import { mark } from "./followups";
import { RunMetrics, RunOptions } from "./metrics";
import { setActiveSession } from "./session";
import { runOpenCode } from "./run-cli";
import { runOpenCodeServer } from "./run-server";

export { runOpenCode } from "./run-cli";
export { runOpenCodeServer } from "./run-server";
export { applyServerPart, emitKeyedDelta, stepDetail } from "./run-steps";
export {
    HEADLESS_PERMISSION,
    abortServerRun,
    compactSession,
    createServerSession,
    isAttachFailure,
    isMissingSessionError,
    isMissingSessionRun,
    safeSessionId,
    sessionBusy,
    sessionModel,
    sessionPath,
    sessionRoot,
    turnPermission
} from "./server-session";

// Drop the dead id, forget it, and run the same prompt again on a new session.
// The turn is answered instead of lost, and workspaceState is cleared so the
// next turn does not repeat the failure.
export async function restartAfterMissingSession(
    runOpts: RunOptions,
    serverTransport: boolean,
    beat: { phase: (text: string) => void },
    response: vscode.ChatResponseStream,
    cwd: string
): Promise<RunMetrics> {
    const dead = runOpts.sessionId;
    logChannel.appendLine(
        `[${stamp()}] session ${dead} no longer exists — starting a fresh one and retrying this turn`
    );
    beat.phase("Previous session is gone — starting a fresh one");
    response.markdown(
        `> ${mark("restart")} The previous OpenCode session (\`${dead}\`) no longer exists, so this turn starts a new one. Earlier conversation history is not available.\n\n`
    );
    await setActiveSession(cwd, { turns: 0 });
    runOpts.sessionId = undefined;
    return (serverTransport ? runOpenCodeServer : runOpenCode)(runOpts);
}
