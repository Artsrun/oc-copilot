"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.insertIntoChat = exports.chatQuery = exports.composeLanes = exports.laneProblem = void 0;
exports.composeParallel = composeParallel;
const vscode = __importStar(require("vscode"));
const core_1 = require("./core");
const models_1 = require("./models");
const chat_boot_1 = require("./chat-boot");
const laneProblem = (task) => {
    const t = task.trim();
    if (!t) {
        return "Describe what this lane should do.";
    }
    if (/^(?:m|model|models)\s*[:=]/i.test(t)) {
        return "Pick the model in the previous step; start the task with words.";
    }
    const n = (0, chat_boot_1.splitLanes)(t).length;
    return n > 1 ? `\`|\`, \`;;\` or a \`---\` line would split this into ${n} lanes — put code in backticks.` : undefined;
};
exports.laneProblem = laneProblem;
const composeLanes = (lanes) => lanes.map((l) => (l.model ? `m:${l.model} ` : "") + l.task.trim()).join("\n---\n");
exports.composeLanes = composeLanes;
const chatQuery = (lanes) => `@opencode /parallel ${(0, exports.composeLanes)(lanes)}`;
exports.chatQuery = chatQuery;
const insertIntoChat = async (query) => {
    try {
        await vscode.commands.executeCommand("workbench.action.chat.open", { query, isPartialQuery: true });
        return true;
    }
    catch {
        return false;
    }
};
exports.insertIntoChat = insertIntoChat;
async function composeParallel(token) {
    const cwd = (0, core_1.resolveFolder)()?.folder.uri.fsPath;
    const settings = (0, core_1.config)();
    const catalog = cwd ? await (0, models_1.getModelCatalog)(settings.get("executable", "opencode"), cwd) : { models: [], info: {} };
    const pin = settings.get("model", "").trim();
    const models = [
        { label: "$(star) Default model", description: pin ? (0, models_1.modelLabel)(pin, catalog.info) : "OpenCode picks", alwaysShow: true },
        ...catalog.models.map((id) => ({ label: (0, models_1.modelLabel)(id, catalog.info), description: id, model: id, alwaysShow: true }))
    ];
    const submitButton = { iconPath: new vscode.ThemeIcon("check"), tooltip: "Submit — insert the lanes into the chat input" };
    const qp = vscode.window.createQuickPick();
    qp.ignoreFocusOut = true;
    const lanes = [];
    const render = (problem) => {
        const n = lanes.length + 1;
        qp.title = `Parallel · lane ${n}${problem ? ` — ${problem}` : ""}`;
        qp.step = n;
        qp.totalSteps = Math.max(2, n);
        qp.placeholder = `Lane ${n}: type the task, then Enter (default model) or pick a model`;
        const submit = lanes.length >= 2
            ? [{ label: `$(check) Submit — insert ${lanes.length} lanes`, detail: "Adds the lane typed above, if any. Nothing is sent until you press Enter in chat.", alwaysShow: true, submit: true }]
            : [];
        qp.items = [...models, ...submit];
        qp.activeItems = [models[0]];
        qp.buttons = lanes.length >= 2 ? [submitButton] : [];
    };
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (!settled) {
                settled = true;
                resolve(result);
                qp.dispose();
            }
        };
        const submit = () => {
            const typed = qp.value.trim();
            if (typed) {
                const problem = (0, exports.laneProblem)(typed);
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
            const problem = (0, exports.laneProblem)(qp.value);
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
//# sourceMappingURL=compose.js.map