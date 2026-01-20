import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
// ============================================================================
// Storage
// ============================================================================
const APPROVALS_DIR = join(homedir(), ".clawdbot", "approvals");
const AUDIT_LOG_PATH = join(homedir(), ".clawdbot", "approvals", "audit.jsonl");
const DEFAULT_EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 hours
function ensureDir() {
    if (!existsSync(APPROVALS_DIR)) {
        mkdirSync(APPROVALS_DIR, { recursive: true });
    }
}
function appendAuditLog(entry) {
    ensureDir();
    appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n");
}
function readAuditLog(limit = 100) {
    if (!existsSync(AUDIT_LOG_PATH))
        return [];
    try {
        const lines = readFileSync(AUDIT_LOG_PATH, "utf-8").trim().split("\n").filter(Boolean);
        const entries = lines.map(line => JSON.parse(line));
        return entries.slice(-limit).reverse(); // most recent first
    }
    catch {
        return [];
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
        proposedBy: options.proposedBy,
        status: "pending",
    };
    saveApproval(approval);
    appendAuditLog({
        ts: approval.createdAt,
        event: "proposed",
        id: approval.id,
        summary: approval.summary,
        actor: options.proposedBy,
        channel: options.channel,
        details: { commands: approval.commands, expiresAt: approval.expiresAt },
    });
    return approval;
}
function approve(id, approvedBy) {
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
        appendAuditLog({
            ts: new Date().toISOString(),
            event: "expired",
            id: approval.id,
            summary: approval.summary,
        });
        throw new Error(`Approval ${id} has expired`);
    }
    approval.status = "approved";
    approval.approvedAt = new Date().toISOString();
    approval.approvedBy = approvedBy;
    saveApproval(approval);
    appendAuditLog({
        ts: approval.approvedAt,
        event: "approved",
        id: approval.id,
        summary: approval.summary,
        actor: approvedBy,
        channel: approval.channel,
    });
    return approval;
}
function deny(id, deniedBy) {
    const approval = loadApproval(id.toUpperCase());
    if (!approval) {
        throw new Error(`Approval ${id} not found`);
    }
    if (approval.status !== "pending") {
        throw new Error(`Approval ${id} is ${approval.status}, not pending`);
    }
    approval.status = "denied";
    approval.deniedAt = new Date().toISOString();
    approval.deniedBy = deniedBy;
    saveApproval(approval);
    appendAuditLog({
        ts: approval.deniedAt,
        event: "denied",
        id: approval.id,
        summary: approval.summary,
        actor: deniedBy,
        channel: approval.channel,
    });
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
    appendAuditLog({
        ts: approval.executedAt,
        event: "executed",
        id: approval.id,
        summary: approval.summary,
        actor: approval.approvedBy,
        channel: approval.channel,
        details: {
            commandCount: approval.commands.length,
            hasErrors: errors.length > 0,
        },
    });
    return approval;
}
function approveAndExecute(id, actor) {
    const approved = approve(id, actor);
    return execute(approved.id);
}
function batchApprove(ids, actor) {
    const results = [];
    const errors = [];
    const toProcess = ids === "all"
        ? listApprovals(false).map(a => a.id)
        : ids;
    for (const id of toProcess) {
        try {
            const result = approveAndExecute(id, actor);
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
    const cleanedIds = [];
    for (const a of all) {
        if (a.status !== "pending" && new Date(a.createdAt) < cutoff) {
            deleteApproval(a.id);
            cleanedIds.push(a.id);
            removed++;
        }
    }
    if (removed > 0) {
        appendAuditLog({
            ts: new Date().toISOString(),
            event: "cleaned",
            id: cleanedIds.join(","),
            summary: `Cleaned ${removed} old approval(s)`,
            details: { count: removed, olderThanDays },
        });
    }
    return removed;
}
function getStats() {
    const all = listApprovals(true);
    const byStatus = {};
    for (const a of all) {
        byStatus[a.status] = (byStatus[a.status] || 0) + 1;
    }
    return {
        total: all.length,
        byStatus,
        recentActivity: readAuditLog(20),
    };
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
            .option("--as <actor>", "Who is approving (e.g., 'user:jonathan')")
            .action((ids, opts) => {
            const actor = opts.as || `cli:${process.env.USER || "unknown"}`;
            try {
                if (ids.length === 1 && ids[0].toLowerCase() === "all") {
                    const result = batchApprove("all", actor);
                    console.log(`Processed ${result.approved.length} approval(s)`);
                    for (const a of result.approved) {
                        console.log(`  ✓ ${a.id}: ${a.summary}`);
                    }
                    for (const e of result.errors) {
                        console.error(`  ✗ ${e.id}: ${e.error}`);
                    }
                }
                else if (ids.length > 1) {
                    const result = batchApprove(ids, actor);
                    console.log(`Processed ${result.approved.length} approval(s)`);
                    for (const a of result.approved) {
                        console.log(`  ✓ ${a.id}: ${a.summary}`);
                    }
                    for (const e of result.errors) {
                        console.error(`  ✗ ${e.id}: ${e.error}`);
                    }
                }
                else {
                    const executed = approveAndExecute(ids[0], actor);
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
            .option("--as <actor>", "Who is denying")
            .action((id, opts) => {
            const actor = opts.as || `cli:${process.env.USER || "unknown"}`;
            try {
                const denied = deny(id, actor);
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
            const removed = cleanExpired(parseInt(opts.days, 10));
            console.log(`Removed ${removed} old approval(s)`);
        });
        cmd
            .command("history")
            .description("Show audit history of approvals")
            .option("-n, --limit <n>", "Number of entries to show", "20")
            .option("--json", "Output as JSON")
            .action((opts) => {
            const entries = readAuditLog(parseInt(opts.limit, 10));
            if (opts.json) {
                console.log(JSON.stringify(entries, null, 2));
                return;
            }
            if (entries.length === 0) {
                console.log("No audit history yet");
                return;
            }
            console.log("Audit History (most recent first):\n");
            console.log("TIME                 EVENT      ID     ACTOR          SUMMARY");
            console.log("─".repeat(80));
            for (const e of entries) {
                const time = new Date(e.ts).toLocaleString("en-US", {
                    month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit"
                });
                const event = e.event.padEnd(10);
                const id = e.id.substring(0, 6).padEnd(6);
                const actor = (e.actor || "-").substring(0, 14).padEnd(14);
                const summary = e.summary.substring(0, 30);
                console.log(`${time}  ${event} ${id} ${actor} ${summary}`);
            }
        });
        cmd
            .command("stats")
            .description("Show approval statistics")
            .action(() => {
            const stats = getStats();
            console.log("Approval Statistics\n");
            console.log(`Total records: ${stats.total}`);
            console.log("\nBy status:");
            for (const [status, count] of Object.entries(stats.byStatus)) {
                console.log(`  ${status}: ${count}`);
            }
            if (stats.recentActivity.length > 0) {
                console.log("\nRecent activity:");
                for (const e of stats.recentActivity.slice(0, 5)) {
                    const time = new Date(e.ts).toLocaleString("en-US", {
                        month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit"
                    });
                    console.log(`  ${time} - ${e.event}: ${e.summary}`);
                }
            }
        });
        // For testing: propose from CLI
        cmd
            .command("propose <summary>")
            .description("Create a test approval (for debugging)")
            .option("-c, --command <cmd...>", "Commands to execute")
            .option("--by <actor>", "Who is proposing")
            .action((summary, opts) => {
            const commands = opts.command || ["echo 'No commands specified'"];
            const approval = propose(summary, commands, { proposedBy: opts.by || "cli" });
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
- history: Get audit log of all approval events
- stats: Get statistics about approvals

Example flow:
1. Call with action="propose", summary="Archive 15 promo emails", commands=["gog gmail thread X --archive", ...], actor="cron:email-triage"
2. Send the returned message to the user
3. User replies "approve ABC1"
4. Call with action="approveAndExecute", id="ABC1", actor="user:jonathan" to approve and run the commands`,
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                action: {
                    type: "string",
                    enum: ["propose", "list", "check", "execute", "approve", "deny", "approveAndExecute", "batch", "clean", "history", "stats"],
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
                actor: {
                    type: "string",
                    description: "Who is performing this action (e.g., 'user:jonathan', 'cron:email-triage', 'clawd')",
                },
                days: {
                    type: "number",
                    description: "Days of history to keep (for clean, default: 7)",
                },
                limit: {
                    type: "number",
                    description: "Number of entries to return (for history, default: 20)",
                },
            },
            required: ["action"],
        },
        execute: async (_toolCallId, params, _signal, _onUpdate) => {
            const { action, id, ids, summary, details, commands, expiryMinutes, channel, chatId, actor, days, limit } = params;
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
                    const approval = propose(summary, commands, { details, expiryMs, channel, chatId, proposedBy: actor });
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
                    const approved = approve(id, actor);
                    return jsonResult({
                        ok: true,
                        message: `Approved ${approved.id}`,
                        approval: {
                            id: approved.id,
                            status: approved.status,
                            approvedBy: approved.approvedBy,
                        },
                    });
                }
                case "deny": {
                    if (!id)
                        throw new Error("id is required for deny");
                    const denied = deny(id, actor);
                    return jsonResult({
                        ok: true,
                        message: `Denied ${denied.id}`,
                        approval: {
                            id: denied.id,
                            status: denied.status,
                            deniedBy: denied.deniedBy,
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
                    const executed = approveAndExecute(id, actor);
                    return jsonResult({
                        ok: true,
                        message: `Approved and executed ${executed.id}`,
                        approval: {
                            id: executed.id,
                            status: executed.status,
                            approvedBy: executed.approvedBy,
                            result: executed.result,
                            error: executed.error,
                        },
                    });
                }
                case "batch": {
                    if (!ids || ids.length === 0)
                        throw new Error("ids array is required for batch");
                    const toProcess = ids.length === 1 && ids[0].toLowerCase() === "all" ? "all" : ids;
                    const result = batchApprove(toProcess, actor);
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
                case "history": {
                    const entries = readAuditLog(limit ?? 20);
                    return jsonResult({
                        ok: true,
                        count: entries.length,
                        entries: entries.map(e => ({
                            ts: e.ts,
                            event: e.event,
                            id: e.id,
                            summary: e.summary,
                            actor: e.actor,
                            channel: e.channel,
                        })),
                    });
                }
                case "stats": {
                    const stats = getStats();
                    return jsonResult({
                        ok: true,
                        total: stats.total,
                        byStatus: stats.byStatus,
                        recentActivity: stats.recentActivity.slice(0, 5).map(e => ({
                            ts: e.ts,
                            event: e.event,
                            id: e.id,
                            summary: e.summary,
                        })),
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
    api.registerGatewayMethod("approvals.propose", async ({ summary, commands, details, expiryMinutes, channel, chatId, actor, }) => {
        const expiryMs = expiryMinutes ? expiryMinutes * 60 * 1000 : DEFAULT_EXPIRY_MS;
        const approval = propose(summary, commands, { details, expiryMs, channel, chatId, proposedBy: actor });
        return {
            ok: true,
            approval,
            message: formatApprovalMessage(approval),
        };
    });
    api.registerGatewayMethod("approvals.approve", async ({ id, actor }) => {
        const approved = approve(id, actor);
        return { ok: true, approval: approved };
    });
    api.registerGatewayMethod("approvals.deny", async ({ id, actor }) => {
        const denied = deny(id, actor);
        return { ok: true, approval: denied };
    });
    api.registerGatewayMethod("approvals.execute", async ({ id }) => {
        const executed = execute(id);
        return { ok: true, approval: executed };
    });
    api.registerGatewayMethod("approvals.approveAndExecute", async ({ id, actor }) => {
        const executed = approveAndExecute(id, actor);
        return { ok: true, approval: executed };
    });
    api.registerGatewayMethod("approvals.batch", async ({ ids, actor }) => {
        const toProcess = ids.length === 1 && ids[0].toLowerCase() === "all" ? "all" : ids;
        const result = batchApprove(toProcess, actor);
        return { ok: true, ...result };
    });
    api.registerGatewayMethod("approvals.clean", async ({ days } = {}) => {
        const removed = cleanExpired(days ?? 7);
        return { ok: true, removed };
    });
    api.registerGatewayMethod("approvals.history", async ({ limit } = {}) => {
        const entries = readAuditLog(limit ?? 20);
        return { ok: true, entries };
    });
    api.registerGatewayMethod("approvals.stats", async () => {
        const stats = getStats();
        return { ok: true, ...stats };
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
