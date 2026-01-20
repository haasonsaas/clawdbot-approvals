# clawdbot-approvals

Clawdbot plugin for action approvals - propose, review, and execute actions safely.

## Install

Add to your `~/.clawdbot/clawdbot.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/clawdbot-approvals"]
    },
    "entries": {
      "approvals": {
        "enabled": true
      }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allowPlugins": ["approvals"]
        }
      }
    ]
  }
}
```

Then restart the gateway.

## Usage

### CLI Commands

```sh
# List pending approvals
clawdbot approve list
clawdbot approve list --all      # Include completed/expired

# Approve and execute (single or multiple)
clawdbot approve yes <id>
clawdbot approve yes <id1> <id2> <id3>
clawdbot approve yes all         # Approve all pending

# Deny
clawdbot approve no <id>

# Show details
clawdbot approve show <id>

# Clean old approvals
clawdbot approve clean --days 7
```

### Agent Tool

Clawd can use the `approvals` tool with these actions:

```
action="propose"           Create a new approval request
action="list"              List pending approvals
action="check"             Check status of specific approval
action="approve"           Mark approval as approved
action="deny"              Mark approval as denied
action="execute"           Execute an approved action
action="approveAndExecute" Approve and execute in one call (recommended)
action="batch"             Approve and execute multiple at once
action="clean"             Remove old completed/expired approvals
```

### Example Flow

1. Cron job proposes an action:
   ```
   approvals(action="propose", summary="Archive 37 promo emails", commands=["gog gmail thread X --archive", ...])
   ```

2. Clawd sends message to user:
   ```
   **Approval needed: `A7K3`**
   Archive 37 promo emails

   Reply `approve A7K3` or `deny A7K3`
   Expires: 10:15am (2 hours)
   ```

3. User replies `approve A7K3`

4. Clawd executes:
   ```
   approvals(action="approveAndExecute", id="A7K3")
   ```

### Batch Approvals

Approve multiple at once:
```
approvals(action="batch", ids=["A7K3", "B2X9", "C4Z1"])
```

Or approve all pending:
```
approvals(action="batch", ids=["all"])
```

## Storage

Approvals are stored as JSON files in `~/.clawdbot/approvals/`.

A cleanup service runs hourly to remove approvals older than 7 days.

## Configuration

Default expiry is 2 hours. Can be overridden per-approval with `expiryMinutes` parameter.

Channel tracking is supported via `channel` and `chatId` parameters for tracing where approvals originated.
