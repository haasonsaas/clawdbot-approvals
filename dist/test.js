import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { rmSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { propose, approve, deny, execute, approveAndExecute, batchApprove, cleanExpired, listApprovals, loadApproval, deleteApproval, readAuditLog, getStats, APPROVALS_DIR, } from "./index.js";
// Helper to clean up test approvals
function cleanupTestApprovals() {
    const files = existsSync(APPROVALS_DIR)
        ? readdirSync(APPROVALS_DIR).filter(f => f.startsWith("TEST") || f.endsWith(".lock"))
        : [];
    for (const f of files) {
        try {
            rmSync(join(APPROVALS_DIR, f));
        }
        catch { }
    }
}
// Helper to create a test approval with predictable ID prefix
function createTestApproval(summary, commands, options = {}) {
    return propose(summary, commands, {
        ...options,
        proposedBy: options.proposedBy || "test",
    });
}
describe("Approval Lifecycle", () => {
    beforeEach(() => {
        cleanupTestApprovals();
    });
    afterEach(() => {
        cleanupTestApprovals();
    });
    test("propose creates a pending approval", () => {
        const approval = createTestApproval("Test proposal", ["echo test"]);
        assert.ok(approval.id, "Should have an ID");
        assert.strictEqual(approval.id.length, 8, "ID should be 8 characters");
        assert.strictEqual(approval.status, "pending");
        assert.strictEqual(approval.summary, "Test proposal");
        assert.deepStrictEqual(approval.commands, ["echo test"]);
        assert.ok(approval.createdAt, "Should have createdAt");
        assert.ok(approval.expiresAt, "Should have expiresAt");
        // Cleanup
        deleteApproval(approval.id);
    });
    test("approve changes status to approved", () => {
        const approval = createTestApproval("Test approval", ["echo approved"]);
        const approved = approve(approval.id, "test-user");
        assert.strictEqual(approved.status, "approved");
        assert.strictEqual(approved.approvedBy, "test-user");
        assert.ok(approved.approvedAt, "Should have approvedAt");
        // Cleanup
        deleteApproval(approval.id);
    });
    test("deny changes status to denied", () => {
        const approval = createTestApproval("Test deny", ["echo denied"]);
        const denied = deny(approval.id, "test-user");
        assert.strictEqual(denied.status, "denied");
        assert.strictEqual(denied.deniedBy, "test-user");
        assert.ok(denied.deniedAt, "Should have deniedAt");
        // Cleanup
        deleteApproval(approval.id);
    });
    test("execute runs commands and sets status to executed", () => {
        const approval = createTestApproval("Test execute", ["echo 'hello world'"]);
        approve(approval.id, "test-user");
        const executed = execute(approval.id);
        assert.strictEqual(executed.status, "executed");
        assert.ok(executed.executedAt, "Should have executedAt");
        assert.ok(executed.result?.includes("hello world"), "Should have command output");
        assert.strictEqual(executed.error, undefined, "Should not have errors");
        // Cleanup
        deleteApproval(approval.id);
    });
    test("approveAndExecute does both in one call", () => {
        const approval = createTestApproval("Test approve and execute", ["echo 'combined'"]);
        const executed = approveAndExecute(approval.id, "test-user");
        assert.strictEqual(executed.status, "executed");
        assert.strictEqual(executed.approvedBy, "test-user");
        assert.ok(executed.result?.includes("combined"));
        // Cleanup
        deleteApproval(approval.id);
    });
});
describe("Error Handling", () => {
    beforeEach(() => {
        cleanupTestApprovals();
    });
    afterEach(() => {
        cleanupTestApprovals();
    });
    test("approve throws for non-existent approval", () => {
        assert.throws(() => approve("NONEXIST"), /not found/i);
    });
    test("approve throws for already approved", () => {
        const approval = createTestApproval("Test double approve", ["echo test"]);
        approve(approval.id, "first-user");
        assert.throws(() => approve(approval.id, "second-user"), /not pending/i);
        // Cleanup
        deleteApproval(approval.id);
    });
    test("execute throws for non-approved", () => {
        const approval = createTestApproval("Test execute pending", ["echo test"]);
        assert.throws(() => execute(approval.id), /must be approved/i);
        // Cleanup
        deleteApproval(approval.id);
    });
    test("execute throws for denied approval", () => {
        const approval = createTestApproval("Test execute denied", ["echo test"]);
        deny(approval.id, "test-user");
        assert.throws(() => execute(approval.id), /must be approved/i);
        // Cleanup
        deleteApproval(approval.id);
    });
    test("deny throws for non-pending", () => {
        const approval = createTestApproval("Test deny approved", ["echo test"]);
        approve(approval.id, "test-user");
        assert.throws(() => deny(approval.id, "another-user"), /not pending/i);
        // Cleanup
        deleteApproval(approval.id);
    });
});
describe("Expiry Enforcement", () => {
    beforeEach(() => {
        cleanupTestApprovals();
    });
    afterEach(() => {
        cleanupTestApprovals();
    });
    test("approve throws for expired approval", () => {
        // Create approval that expires immediately (1ms)
        const approval = createTestApproval("Test expired", ["echo test"], {
            expiryMs: 1,
        });
        // Wait a bit for it to expire
        const wait = (ms) => {
            const end = Date.now() + ms;
            while (Date.now() < end) { }
        };
        wait(10);
        assert.throws(() => approve(approval.id, "test-user"), /expired/i);
        // Cleanup
        deleteApproval(approval.id);
    });
    test("execute throws for expired-after-approval", () => {
        // Create approval that expires in 50ms
        const approval = createTestApproval("Test expired after approve", ["echo test"], {
            expiryMs: 50,
        });
        // Approve immediately
        approve(approval.id, "test-user");
        // Wait for it to expire
        const wait = (ms) => {
            const end = Date.now() + ms;
            while (Date.now() < end) { }
        };
        wait(100);
        assert.throws(() => execute(approval.id), /expired/i);
        // Cleanup
        deleteApproval(approval.id);
    });
    test("listApprovals marks expired as expired", () => {
        const approval = createTestApproval("Test list expired", ["echo test"], {
            expiryMs: 1,
        });
        // Wait for expiry
        const wait = (ms) => {
            const end = Date.now() + ms;
            while (Date.now() < end) { }
        };
        wait(10);
        // List should mark it as expired
        listApprovals(true);
        const loaded = loadApproval(approval.id);
        assert.strictEqual(loaded?.status, "expired");
        // Cleanup
        deleteApproval(approval.id);
    });
});
describe("Failure Status", () => {
    beforeEach(() => {
        cleanupTestApprovals();
    });
    afterEach(() => {
        cleanupTestApprovals();
    });
    test("failed status when all commands fail", () => {
        const approval = createTestApproval("Test all fail", ["exit 1"]);
        approve(approval.id, "test-user");
        const executed = execute(approval.id);
        assert.strictEqual(executed.status, "failed");
        assert.ok(executed.error, "Should have error output");
        assert.ok(executed.error?.includes("EXIT: 1"), "Should include exit code");
        // Cleanup
        deleteApproval(approval.id);
    });
    test("partial status when some commands fail", () => {
        const approval = createTestApproval("Test partial fail", [
            "echo 'success'",
            "exit 1",
            "echo 'also success'",
        ]);
        approve(approval.id, "test-user");
        const executed = execute(approval.id);
        assert.strictEqual(executed.status, "partial");
        assert.ok(executed.result?.includes("success"), "Should have success output");
        assert.ok(executed.error?.includes("EXIT: 1"), "Should have error output");
        // Cleanup
        deleteApproval(approval.id);
    });
    test("executed status when all commands succeed", () => {
        const approval = createTestApproval("Test all succeed", [
            "echo 'one'",
            "echo 'two'",
        ]);
        approve(approval.id, "test-user");
        const executed = execute(approval.id);
        assert.strictEqual(executed.status, "executed");
        assert.ok(executed.result?.includes("one"));
        assert.ok(executed.result?.includes("two"));
        assert.strictEqual(executed.error, undefined);
        // Cleanup
        deleteApproval(approval.id);
    });
});
describe("Batch Operations", () => {
    beforeEach(() => {
        cleanupTestApprovals();
    });
    afterEach(() => {
        cleanupTestApprovals();
    });
    test("batchApprove processes multiple approvals", () => {
        const a1 = createTestApproval("Batch 1", ["echo one"]);
        const a2 = createTestApproval("Batch 2", ["echo two"]);
        const a3 = createTestApproval("Batch 3", ["echo three"]);
        const result = batchApprove([a1.id, a2.id, a3.id], "batch-user");
        assert.strictEqual(result.approved.length, 3);
        assert.strictEqual(result.errors.length, 0);
        for (const a of result.approved) {
            assert.strictEqual(a.status, "executed");
            assert.strictEqual(a.approvedBy, "batch-user");
        }
        // Cleanup
        deleteApproval(a1.id);
        deleteApproval(a2.id);
        deleteApproval(a3.id);
    });
    test("batchApprove handles mixed success and failure", () => {
        const a1 = createTestApproval("Batch success", ["echo ok"]);
        const a2 = createTestApproval("Batch fail", ["exit 1"]);
        const result = batchApprove([a1.id, a2.id], "batch-user");
        // Both should be processed (one executed, one failed)
        assert.strictEqual(result.approved.length, 2);
        assert.strictEqual(result.errors.length, 0);
        const success = result.approved.find(a => a.id === a1.id);
        const failed = result.approved.find(a => a.id === a2.id);
        assert.strictEqual(success?.status, "executed");
        assert.strictEqual(failed?.status, "failed");
        // Cleanup
        deleteApproval(a1.id);
        deleteApproval(a2.id);
    });
});
describe("Audit Log", () => {
    beforeEach(() => {
        cleanupTestApprovals();
    });
    afterEach(() => {
        cleanupTestApprovals();
    });
    test("actions are logged to audit log", () => {
        const beforeCount = readAuditLog(1000).length;
        const approval = createTestApproval("Audit test", ["echo audit"]);
        approveAndExecute(approval.id, "audit-user");
        const log = readAuditLog(10);
        const afterCount = readAuditLog(1000).length;
        // Should have at least 3 new entries: proposed, approved, executed
        assert.ok(afterCount >= beforeCount + 3, `Expected at least 3 new entries, got ${afterCount - beforeCount}`);
        // Most recent should be executed
        const executed = log.find(e => e.event === "executed" && e.id === approval.id);
        assert.ok(executed, "Should have executed event");
        assert.strictEqual(executed?.actor, "audit-user");
        // Cleanup
        deleteApproval(approval.id);
    });
});
describe("Stats", () => {
    beforeEach(() => {
        cleanupTestApprovals();
    });
    afterEach(() => {
        cleanupTestApprovals();
    });
    test("getStats returns correct counts", () => {
        const a1 = createTestApproval("Stats pending", ["echo one"]);
        const a2 = createTestApproval("Stats executed", ["echo two"]);
        const a3 = createTestApproval("Stats denied", ["echo three"]);
        approveAndExecute(a2.id, "test");
        deny(a3.id, "test");
        const stats = getStats();
        assert.ok(stats.total >= 3, "Should have at least 3 approvals");
        assert.ok(stats.byStatus.pending >= 1, "Should have at least 1 pending");
        assert.ok(stats.byStatus.executed >= 1, "Should have at least 1 executed");
        assert.ok(stats.byStatus.denied >= 1, "Should have at least 1 denied");
        // Cleanup
        deleteApproval(a1.id);
        deleteApproval(a2.id);
        deleteApproval(a3.id);
    });
});
describe("ID Generation", () => {
    test("IDs are 8 characters", () => {
        const approval = createTestApproval("ID test", ["echo test"]);
        assert.strictEqual(approval.id.length, 8);
        deleteApproval(approval.id);
    });
    test("IDs are unique across multiple proposals", () => {
        const ids = new Set();
        const approvals = [];
        for (let i = 0; i < 20; i++) {
            const a = createTestApproval(`Unique test ${i}`, ["echo test"]);
            ids.add(a.id);
            approvals.push(a);
        }
        assert.strictEqual(ids.size, 20, "All IDs should be unique");
        // Cleanup
        for (const a of approvals) {
            deleteApproval(a.id);
        }
    });
});
describe("Cleanup", () => {
    test("cleanExpired removes old completed approvals", () => {
        // This test is tricky because we can't easily age approvals
        // Just verify the function runs without error
        const removed = cleanExpired(365); // Use a long period to avoid removing real data
        assert.ok(removed >= 0, "Should return a number");
    });
});
console.log("Running approval tests...");
