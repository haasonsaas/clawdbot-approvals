import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
// ============================================================================
// Storage
// ============================================================================
const APPROVALS_DIR = join(homedir(), ".clawdbot", "approvals");
const DEFAULT_EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 hours
function ensureDir() {
    if (!existsSync(APPROVALS_DIR)) {
        mkdirSync(APPROVALS_DIR, { recursive: true });
    }
}
function generateId() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 for clarity
    let id = "";
    for (let i = 0; i < 4; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
}
function getApprovalPath(id) {
    return join(APPROVALS_DIR, `${id}.json`);
}
function loadApproval(id) {
    const path = getApprovalPath(id);
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, "utf-8"));
    }
    catch {
        return null;
    }
}
function saveApproval(approval) {
    ensureDir();
    writeFileSync(getApprovalPath(approval.id), JSON.stringify(approval, null, 2));
}
function deleteApproval(id) {
    const path = getApprovalPath(id);
    if (existsSync(path)) {
        unlinkSync(path);
    }
}
function listApprovals(includeAll = false) {
    ensureDir();
    const files = readdirSync(APPROVALS_DIR).filter((f) => f.endsWith(".json"));
    const approvals = [];
    const now = new Date();
    for (const file of files) {
        try {
            const approval = JSON.parse(readFileSync(join(APPROVALS_DIR, file), "utf-8"));
            // Check expiry
            if (approval.status === "pending" && new Date(approval.expiresAt) < now) {
                approval.status = "expired";
                saveApproval(approval);
            }
            if (includeAll || approval.status === "pending") {
                approvals.push(approval);
            }
        }
        catch {
            // Skip invalid files
        }
    }
    return approvals.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
// ============================================================================
// Core Logic
// ============================================================================
function propose(summary, commands, options = {}) {
    const now = new Date();
    const expiryMs = options.expiryMs ?? DEFAULT_EXPIRY_MS;
    const approval = {
        id: generateId(),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + expiryMs).toISOString(),
        summary,
        details: options.details,
        commands,
        env: options.env,
        channel: options.channel,
        chatId: options.chatId,
        status: "pending",
    };
    saveApproval(approval);
    return approval;
}
function approve(id) {
    const approval = loadApproval(id.toUpperCase());
    if (!approval) {
        throw new Error(`Approval ${id} not found`);
    }
    if (approval.status !== "pending") {
        throw new Error(`Approval ${id} is ${approval.status}, not pending`);
    }
    if (new Date(approval.expiresAt) < new Date()) {
        approval.status = "expired";
        saveApproval(approval);
        throw new Error(`Approval ${id} has expired`);
    }
    approval.status = "approved";
    approval.approvedAt = new Date().toISOString();
    saveApproval(approval);
    return approval;
}
function deny(id) {
    const approval = loadApproval(id.toUpperCase());
    if (!approval) {
        throw new Error(`Approval ${id} not found`);
    }
    if (approval.status !== "pending") {
        throw new Error(`Approval ${id} is ${approval.status}, not pending`);
    }
    approval.status = "denied";
    approval.deniedAt = new Date().toISOString();
    saveApproval(approval);
    return approval;
}
function execute(id) {
    const approval = loadApproval(id.toUpperCase());
    if (!approval) {
        throw new Error(`Approval ${id} not found`);
    }
    if (approval.status !== "approved") {
        throw new Error(`Approval ${id} is ${approval.status}, must be approved first`);
    }
    const results = [];
    const errors = [];
    const env = {
        ...process.env,
        PATH: `/opt/homebrew/bin:${process.env.PATH}`,
        ...approval.env,
    };
    for (const cmd of approval.commands) {
        try {
            const output = execSync(cmd, {
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "pipe"],
                shell: "/bin/bash",
                env,
                timeout: 60000, // 1 minute per command
            }).trim();
            results.push(`$ ${cmd}\n${output}`);
        }
        catch (err) {
            const errMsg = err.stderr?.toString() || err.message;
            errors.push(`$ ${cmd}\nERROR: ${errMsg}`);
        }
    }
    approval.status = "executed";
    approval.executedAt = new Date().toISOString();
    approval.result = results.join("\n\n");
    if (errors.length > 0) {
        approval.error = errors.join("\n\n");
    }
    saveApproval(approval);
    return approval;
}
function approveAndExecute(id) {
    const approved = approve(id);
    return execute(approved.id);
}
function batchApprove(ids) {
    const results = [];
    const errors = [];
    const toProcess = ids === "all"
        ? listApprovals(false).map(a => a.id)
        : ids;
    for (const id of toProcess) {
        try {
            const result = approveAndExecute(id);
            results.push(result);
        }
        catch (err) {
            errors.push({ id, error: err.message });
        }
    }
    return { approved: results, errors };
}
function cleanExpired(olderThanDays = 7) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    const all = listApprovals(true);
    let removed = 0;
    for (const a of all) {
        if (a.status !== "pending" && new Date(a.createdAt) < cutoff) {
            deleteApproval(a.id);
            removed++;
        }
    }
    return removed;
}
function formatRelativeTime(date) {
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const diffMins = Math.round(diffMs / 60000);
    if (diffMins < 0)
        return "expired";
    if (diffMins < 1)
        return "<1 min";
    if (diffMins < 60)
        return `${diffMins} min`;
    const diffHours = Math.round(diffMins / 60);
    if (diffHours === 1)
        return "1 hour";
    return `${diffHours} hours`;
}
function formatApproval(a, verbose = false) {
    const expiry = new Date(a.expiresAt);
    const relTime = formatRelativeTime(expiry);
    const expiryStr = a.status === "pending" ? ` (${relTime} left)` : "";
    let out = `[${a.id}] ${a.status.toUpperCase()}${expiryStr}\n  ${a.summary}`;
    if (verbose) {
        if (a.details)
            out += `\n  Details: ${a.details}`;
        if (a.channel)
            out += `\n  Channel: ${a.channel}${a.chatId ? ` (${a.chatId})` : ""}`;
        out += `\n  Commands:`;
        for (const cmd of a.commands) {
            out += `\n    $ ${cmd}`;
        }
        if (a.result)
            out += `\n  Result: ${a.result.substring(0, 200)}...`;
        if (a.error)
            out += `\n  Error: ${a.error.substring(0, 200)}...`;
    }
    return out;
}
function formatApprovalMessage(a) {
    const expiry = new Date(a.expiresAt);
    const relTime = formatRelativeTime(expiry);
    const expiryTime = expiry.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
    });
    let msg = `**Approval needed: \`${a.id}\`**\n${a.summary}`;
    if (a.details)
        msg += `\n${a.details}`;
    msg += `\n\nReply \`approve ${a.id}\` or \`deny ${a.id}\``;
    msg += `\nExpires: ${expiryTime} (${relTime})`;
    return msg;
}
// ============================================================================
// Tool Result Helper
// ============================================================================
function jsonResult(payload) {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(payload, null, 2),
            },
        ],
        details: payload,
    };
}
// ============================================================================
// Plugin Export
// ============================================================================
export default function (api) {
    // -------------------------------------------------------------------------
    // CLI Commands
    // -------------------------------------------------------------------------
    api.registerCli(({ program }) => {
        const cmd = program.command("approve").description("Manage action approvals");
        cmd
            .command("list")
            .description("List pending approvals")
            .option("-a, --all", "Include completed/expired approvals")
            .option("-v, --verbose", "Show full details")
            .action((opts) => {
            const approvals = listApprovals(opts.all);
            if (approvals.length === 0) {
                console.log("No pending approvals");
                return;
            }
            console.log(`${approvals.length} approval(s):\n`);
            for (const a of approvals) {
                console.log(formatApproval(a, opts.verbose));
                console.log();
            }
        });
        cmd
            .command("yes <id...>")
            .description("Approve and execute action(s). Use 'all' to approve all pending.")
            .action((ids) => {
            try {
                if (ids.length === 1 && ids[0].toLowerCase() === "all") {
                    const result = batchApprove("all");
                    console.log(`Processed ${result.approved.length} approval(s)`);
                    for (const a of result.approved) {
                        console.log(`  ✓ ${a.id}: ${a.summary}`);
                    }
                    for (const e of result.errors) {
                        console.error(`  ✗ ${e.id}: ${e.error}`);
                    }
                }
                else if (ids.length > 1) {
                    const result = batchApprove(ids);
                    console.log(`Processed ${result.approved.length} approval(s)`);
                    for (const a of result.approved) {
                        console.log(`  ✓ ${a.id}: ${a.summary}`);
                    }
                    for (const e of result.errors) {
                        console.error(`  ✗ ${e.id}: ${e.error}`);
                    }
                }
                else {
                    const executed = approveAndExecute(ids[0]);
                    console.log(`✓ ${executed.id}: ${executed.summary}`);
                    if (executed.result)
                        console.log(executed.result);
                    if (executed.error)
                        console.error(`Errors:\n${executed.error}`);
                }
            }
            catch (err) {
                console.error(`Error: ${err.message}`);
                process.exit(1);
            }
        });
        cmd
            .command("no <id>")
            .description("Deny an approval")
            .action((id) => {
            try {
                const denied = deny(id);
                console.log(`Denied ${denied.id}: ${denied.summary}`);
            }
            catch (err) {
                console.error(`Error: ${err.message}`);
                process.exit(1);
            }
        });
        cmd
            .command("show <id>")
            .description("Show details of an approval")
            .action((id) => {
            const approval = loadApproval(id.toUpperCase());
            if (!approval) {
                console.error(`Approval ${id} not found`);
                process.exit(1);
            }
            console.log(formatApproval(approval, true));
        });
        cmd
            .command("clean")
            .description("Remove old completed/expired approvals")
            .option("-d, --days <days>", "Remove approvals older than N days", "7")
            .action((opts) => {
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - parseInt(opts.days, 10));
            const all = listApprovals(true);
            let removed = 0;
            for (const a of all) {
                if (a.status !== "pending" &&
                    new Date(a.createdAt) < cutoff) {
                    deleteApproval(a.id);
                    removed++;
                }
            }
            console.log(`Removed ${removed} old approval(s)`);
        });
        // For testing: propose from CLI
        cmd
            .command("propose <summary>")
            .description("Create a test approval (for debugging)")
            .option("-c, --command <cmd...>", "Commands to execute")
            .action((summary, opts) => {
            const commands = opts.command || ["echo 'No commands specified'"];
            const approval = propose(summary, commands);
            console.log(formatApprovalMessage(approval));
        });
    }, { commands: ["approve"] });
    // -------------------------------------------------------------------------
    // Agent Tool
    // -------------------------------------------------------------------------
    api.registerTool({
        name: "approvals",
        description: `Manage action approvals. Use this to propose actions that need user confirmation before executing.

Actions:
- propose: Create a new approval request. User must approve before execution.
- list: List pending approvals
- check: Check status of a specific approval
- approve: Mark an approval as approved (still needs execute)
- deny: Mark an approval as denied
- execute: Execute an approved action (only works if status is "approved")
- approveAndExecute: Approve and execute in one call (most common)
- batch: Approve and execute multiple approvals at once
- clean: Remove old completed/expired approvals

Example flow:
1. Call with action="propose", summary="Archive 15 promo emails", commands=["gog gmail thread X --archive", ...]
2. Send the returned message to the user
3. User replies "approve ABC1"
4. Call with action="approveAndExecute", id="ABC1" to approve and run the commands`,
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                action: {
                    type: "string",
                    enum: ["propose", "list", "check", "execute", "approve", "deny", "approveAndExecute", "batch", "clean"],
                    description: "Action to perform",
                },
                id: {
                    type: "string",
                    description: "Approval ID (for check/execute/approve/deny/approveAndExecute)",
                },
                ids: {
                    type: "array",
                    items: { type: "string" },
                    description: "Multiple approval IDs (for batch). Use ['all'] to approve all pending.",
                },
                summary: {
                    type: "string",
                    description: "One-line description of what will happen (for propose)",
                },
                details: {
                    type: "string",
                    description: "Optional longer explanation (for propose)",
                },
                commands: {
                    type: "array",
                    items: { type: "string" },
                    description: "Shell commands to execute when approved (for propose)",
                },
                expiryMinutes: {
                    type: "number",
                    description: "Minutes until expiry (default: 120)",
                },
                channel: {
                    type: "string",
                    description: "Channel this approval was proposed from (for propose)",
                },
                chatId: {
                    type: "string",
                    description: "Chat ID within the channel (for propose)",
                },
                days: {
                    type: "number",
                    description: "Days of history to keep (for clean, default: 7)",
                },
            },
            required: ["action"],
        },
        execute: async (_toolCallId, params, _signal, _onUpdate) => {
            const { action, id, ids, summary, details, commands, expiryMinutes, channel, chatId, days } = params;
            switch (action) {
                case "propose": {
                    if (!summary)
                        throw new Error("summary is required for propose");
                    if (!commands || commands.length === 0) {
                        throw new Error("commands array is required for propose");
                    }
                    const expiryMs = expiryMinutes
                        ? expiryMinutes * 60 * 1000
                        : DEFAULT_EXPIRY_MS;
                    const approval = propose(summary, commands, { details, expiryMs, channel, chatId });
                    return jsonResult({
                        ok: true,
                        approval: {
                            id: approval.id,
                            status: approval.status,
                            expiresAt: approval.expiresAt,
                            expiresIn: formatRelativeTime(new Date(approval.expiresAt)),
                        },
                        message: formatApprovalMessage(approval),
                    });
                }
                case "list": {
                    const pending = listApprovals(false);
                    return jsonResult({
                        ok: true,
                        count: pending.length,
                        approvals: pending.map((a) => ({
                            id: a.id,
                            summary: a.summary,
                            status: a.status,
                            expiresAt: a.expiresAt,
                            expiresIn: formatRelativeTime(new Date(a.expiresAt)),
                        })),
                    });
                }
                case "check": {
                    if (!id)
                        throw new Error("id is required for check");
                    const approval = loadApproval(id.toUpperCase());
                    if (!approval) {
                        return jsonResult({ ok: false, error: `Approval ${id} not found` });
                    }
                    return jsonResult({
                        ok: true,
                        approval: {
                            id: approval.id,
                            summary: approval.summary,
                            status: approval.status,
                            expiresAt: approval.expiresAt,
                            expiresIn: approval.status === "pending" ? formatRelativeTime(new Date(approval.expiresAt)) : undefined,
                            channel: approval.channel,
                            chatId: approval.chatId,
                            result: approval.result,
                            error: approval.error,
                        },
                    });
                }
                case "approve": {
                    if (!id)
                        throw new Error("id is required for approve");
                    const approved = approve(id);
                    return jsonResult({
                        ok: true,
                        message: `Approved ${approved.id}`,
                        approval: {
                            id: approved.id,
                            status: approved.status,
                        },
                    });
                }
                case "deny": {
                    if (!id)
                        throw new Error("id is required for deny");
                    const denied = deny(id);
                    return jsonResult({
                        ok: true,
                        message: `Denied ${denied.id}`,
                        approval: {
                            id: denied.id,
                            status: denied.status,
                        },
                    });
                }
                case "execute": {
                    if (!id)
                        throw new Error("id is required for execute");
                    const executed = execute(id);
                    return jsonResult({
                        ok: true,
                        message: `Executed ${executed.id}`,
                        approval: {
                            id: executed.id,
                            status: executed.status,
                            result: executed.result,
                            error: executed.error,
                        },
                    });
                }
                case "approveAndExecute": {
                    if (!id)
                        throw new Error("id is required for approveAndExecute");
                    const executed = approveAndExecute(id);
                    return jsonResult({
                        ok: true,
                        message: `Approved and executed ${executed.id}`,
                        approval: {
                            id: executed.id,
                            status: executed.status,
                            result: executed.result,
                            error: executed.error,
                        },
                    });
                }
                case "batch": {
                    if (!ids || ids.length === 0)
                        throw new Error("ids array is required for batch");
                    const toProcess = ids.length === 1 && ids[0].toLowerCase() === "all" ? "all" : ids;
                    const result = batchApprove(toProcess);
                    return jsonResult({
                        ok: true,
                        message: `Processed ${result.approved.length} approval(s)${result.errors.length > 0 ? `, ${result.errors.length} error(s)` : ""}`,
                        approved: result.approved.map(a => ({
                            id: a.id,
                            summary: a.summary,
                            status: a.status,
                            result: a.result,
                            error: a.error,
                        })),
                        errors: result.errors,
                    });
                }
                case "clean": {
                    const removed = cleanExpired(days ?? 7);
                    return jsonResult({
                        ok: true,
                        message: `Removed ${removed} old approval(s)`,
                        removed,
                    });
                }
                default:
                    throw new Error(`Unknown action: ${action}`);
            }
        },
    });
    // -------------------------------------------------------------------------
    // Gateway RPC Methods
    // -------------------------------------------------------------------------
    api.registerGatewayMethod("approvals.list", async ({ all } = {}) => {
        const approvals = listApprovals(all);
        return { ok: true, approvals };
    });
    api.registerGatewayMethod("approvals.propose", async ({ summary, commands, details, expiryMinutes, }) => {
        const expiryMs = expiryMinutes ? expiryMinutes * 60 * 1000 : DEFAULT_EXPIRY_MS;
        const approval = propose(summary, commands, { details, expiryMs });
        return {
            ok: true,
            approval,
            message: formatApprovalMessage(approval),
        };
    });
    api.registerGatewayMethod("approvals.approve", async ({ id }) => {
        const approved = approve(id);
        return { ok: true, approval: approved };
    });
    api.registerGatewayMethod("approvals.deny", async ({ id }) => {
        const denied = deny(id);
        return { ok: true, approval: denied };
    });
    api.registerGatewayMethod("approvals.execute", async ({ id }) => {
        const executed = execute(id);
        return { ok: true, approval: executed };
    });
    api.registerGatewayMethod("approvals.approveAndExecute", async ({ id }) => {
        const executed = approveAndExecute(id);
        return { ok: true, approval: executed };
    });
    api.registerGatewayMethod("approvals.batch", async ({ ids }) => {
        const toProcess = ids.length === 1 && ids[0].toLowerCase() === "all" ? "all" : ids;
        const result = batchApprove(toProcess);
        return { ok: true, ...result };
    });
    api.registerGatewayMethod("approvals.clean", async ({ days } = {}) => {
        const removed = cleanExpired(days ?? 7);
        return { ok: true, removed };
    });
    // -------------------------------------------------------------------------
    // Cleanup Service (runs hourly)
    // -------------------------------------------------------------------------
    api.registerService({
        id: "approvals-cleanup",
        start: async () => {
            // Clean up on startup
            const removed = cleanExpired(7);
            if (removed > 0) {
                api.logger.info(`[approvals] cleaned ${removed} old approval(s)`);
            }
            // Schedule hourly cleanup
            const interval = setInterval(() => {
                const removed = cleanExpired(7);
                if (removed > 0) {
                    api.logger.info(`[approvals] cleaned ${removed} old approval(s)`);
                }
            }, 60 * 60 * 1000); // 1 hour
            return () => clearInterval(interval);
        },
    });
}
