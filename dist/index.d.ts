interface Approval {
    id: string;
    createdAt: string;
    expiresAt: string;
    summary: string;
    details?: string;
    commands: string[];
    env?: Record<string, string>;
    channel?: string;
    chatId?: string;
    proposedBy?: string;
    status: "pending" | "approved" | "denied" | "executed" | "expired" | "failed" | "partial";
    approvedAt?: string;
    approvedBy?: string;
    deniedAt?: string;
    deniedBy?: string;
    executedAt?: string;
    result?: string;
    error?: string;
}
interface AuditLogEntry {
    ts: string;
    event: "proposed" | "approved" | "denied" | "executed" | "expired" | "cleaned";
    id: string;
    summary: string;
    actor?: string;
    channel?: string;
    details?: Record<string, any>;
}
declare const APPROVALS_DIR: string;
declare function readAuditLog(limit?: number): AuditLogEntry[];
declare function loadApproval(id: string): Approval | null;
declare function deleteApproval(id: string): void;
declare function listApprovals(includeAll?: boolean): Approval[];
declare function propose(summary: string, commands: string[], options?: {
    details?: string;
    expiryMs?: number;
    env?: Record<string, string>;
    channel?: string;
    chatId?: string;
    proposedBy?: string;
}): Approval;
declare function approve(id: string, approvedBy?: string): Approval;
declare function deny(id: string, deniedBy?: string): Approval;
declare function execute(id: string): Approval;
declare function approveAndExecute(id: string, actor?: string): Approval;
declare function batchApprove(ids: string[] | "all", actor?: string): {
    approved: Approval[];
    errors: {
        id: string;
        error: string;
    }[];
};
declare function cleanExpired(olderThanDays?: number): number;
declare function getStats(): {
    total: number;
    byStatus: Record<string, number>;
    recentActivity: AuditLogEntry[];
};
export default function (api: any): void;
export { propose, approve, deny, execute, approveAndExecute, batchApprove, cleanExpired, listApprovals, loadApproval, deleteApproval, readAuditLog, getStats, APPROVALS_DIR, type Approval, type AuditLogEntry, };
