// The /parallel composer (claim:parallel-composer): lane by lane, a model (default first) and a task,
// then Submit once there are two — the command is inserted into the chat
// input, not sent. A chat participant cannot draw a form inside the chat on
// stable VS Code; quick picks and input boxes are the native step UI.
import * as vscode from "vscode";
import { config, resolveFolder } from "./core";
import { getModelCatalog, modelLabel } from "./models";
import { splitLanes } from "./chat-boot";

export interface ComposedLane {
    model?: string;
    task: string;
}

/** Why a task cannot be one lane as typed, or undefined. Uses the real splitter. */
export const laneProblem = (task: string): string | undefined => {
    const t = task.trim();
    if (!t) {
        return "Describe what this lane should do.";
    }
    if (/^(?:m|model|models)\s*[:=]/i.test(t)) {
        return "Pick the model in the previous step; start the task with words.";
    }
    const n = splitLanes(t).length;
    return n > 1 ? `\`|\`, \`;;\` or a \`---\` line would split this into ${n} lanes — put code in backticks.` : undefined;
};

/** Lanes → the text after `/parallel`, one lane per block. */
export const composeLanes = (lanes: readonly ComposedLane[]): string =>
    lanes.map((l) => (l.model ? `m:${l.model} ` : "") + l.task.trim()).join("\n---\n");

export const chatQuery = (lanes: readonly ComposedLane[]): string => `@opencode /parallel ${composeLanes(lanes)}`;

/** Put the command in the chat input without sending it. */
export const insertIntoChat = async (query: string): Promise<boolean> => {
    try {
        await vscode.commands.executeCommand("workbench.action.chat.open", { query, isPartialQuery: true });
        return true;
    } catch {
        return false;
    }
};

/**
 * One quick pick, one page per lane: its input is the task, its list the
 * models (all `alwaysShow`, so typing never hides them; the default is
 * active). Enter = next lane. From two lanes on, Submit appears as a title
 * button and as the last item; it also takes the lane typed on that page.
 */
export async function composeParallel(token?: vscode.CancellationToken): Promise<ComposedLane[] | undefined> {
    const cwd = resolveFolder()?.folder.uri.fsPath;
    const settings = config();
    const catalog = cwd ? await getModelCatalog(settings.get<string>("executable", "opencode"), cwd) : { models: [], info: {} };
    const pin = settings.get<string>("model", "").trim();
    type Item = vscode.QuickPickItem & { model?: string; submit?: boolean };
    const models: Item[] = [
        { label: "$(star) Default model", description: pin ? modelLabel(pin, catalog.info) : "OpenCode picks", alwaysShow: true },
        ...catalog.models.map((id) => ({ label: modelLabel(id, catalog.info), description: id, model: id, alwaysShow: true }))
    ];
    const submitButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("check"), tooltip: "Submit — insert the lanes into the chat input" };
    const qp = vscode.window.createQuickPick<Item>();
    qp.ignoreFocusOut = true;
    const lanes: ComposedLane[] = [];
    const render = (problem?: string): void => {
        const n = lanes.length + 1;
        qp.title = `Parallel · lane ${n}${problem ? ` — ${problem}` : ""}`;
        qp.step = n;
        qp.totalSteps = Math.max(2, n);
        qp.placeholder = `Lane ${n}: type the task, then Enter (default model) or pick a model`;
        const submit: Item[] = lanes.length >= 2
            ? [{ label: `$(check) Submit — insert ${lanes.length} lanes`, detail: "Adds the lane typed above, if any. Nothing is sent until you press Enter in chat.", alwaysShow: true, submit: true }]
            : [];
        qp.items = [...models, ...submit];
        qp.activeItems = [models[0]];
        qp.buttons = lanes.length >= 2 ? [submitButton] : [];
    };
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result: ComposedLane[] | undefined): void => {
            if (!settled) {
                settled = true;
                resolve(result);
                qp.dispose();
            }
        };
        const submit = (): void => {
            const typed = qp.value.trim();
            if (typed) {
                const problem = laneProblem(typed);
                if (problem) {
                    return render(problem);
                }
                lanes.push({ task: typed });
            }
            finish(lanes);
        };
        qp.onDidAccept(() => {
            const item = qp.activeItems[0] ?? qp.selectedItems[0];
            if (item?.submit) {
                return submit();
            }
            const problem = laneProblem(qp.value);
            if (problem) {
                return render(problem);
            }
            lanes.push({ model: item?.model, task: qp.value.trim() });
            qp.value = "";
            render();
        });
        qp.onDidTriggerButton(() => submit());
        qp.onDidHide(() => finish(undefined));
        token?.onCancellationRequested(() => finish(undefined));
        render();
        qp.show();
    });
}
