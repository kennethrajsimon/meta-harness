# 3DTeam — Agent Fleet Command + Meta Harness

A multi-agent development team with a deep space 3D command dashboard for real-time monitoring and bidirectional control of 10 specialized AI agents — plus a local Meta Harness orchestration layer that implements the AI Super Harness architecture (Protocol, Identity, Discovery, Orchestration, Safety) above the fleet.

## Quick Start

**Windows (cmd.exe):**
```cmd
.fleet\start-dashboard.bat                                    :: Fleet dashboard (port 27182)
set META_HARNESS_ADMIN_TOKEN=your-token  &&  meta-harness\scripts\start-all.bat
```

**Windows (PowerShell):**
```powershell
.fleet\start-dashboard.bat                                    # Fleet dashboard (port 27182)
$env:META_HARNESS_ADMIN_TOKEN = "your-token"
.\meta-harness\scripts\start-all.ps1
```

**macOS / Linux:**
```bash
./.fleet/start-dashboard.sh                  # Fleet dashboard (port 27182)
export META_HARNESS_ADMIN_TOKEN=your-token
bash meta-harness/scripts/start-all.sh       # Meta Harness + broker (port 20000)
```

Fleet dashboard renders the 3D scene and real-time COMMS LOG. Meta Harness exposes:
- Mission-intake API + operator UI at [http://localhost:20000/ui/missions.html](http://localhost:20000/ui/missions.html)
- Self-service agent discovery at [http://localhost:20000/v1/discovery/agent-guide](http://localhost:20000/v1/discovery/agent-guide) (human) / [http://localhost:20000/v1/.well-known/agent-discovery](http://localhost:20000/v1/.well-known/agent-discovery) (JSON)
- MCP bridge (`node meta-harness/bin/meta-mcp.js`) that makes the fleet available to any MCP client
- Guided onboarding CLI: `meta-harness/scripts/onboard-agent.ps1 <name>` (or `.sh`) — pre-flight, key-gen, register, verify, optional simulated round-trip, and writes a personalised runbook. See [meta-harness/README.md](meta-harness/README.md) for details.

If Node.js isn't available, the Fleet dashboard works in offline polling mode. Meta Harness requires Node 18+.

## Architecture

### Agent Team (10 agents)

| Agent | Model | Role | Zone |
|-------|-------|------|------|
| architect | Opus | System design, tech decisions | Architecture & Planning |
| backend | Sonnet | APIs, business logic, server-side | Core Engineering |
| frontend | Sonnet | UI components, state, accessibility | Core Engineering |
| database | Sonnet | Schema design, migrations, queries | Core Engineering |
| qa | Sonnet | Test strategy, testing, bugs | Quality & Security |
| security | Sonnet | Security audits, vulnerability review | Quality & Security |
| reviewer | Haiku | Code quality, PR reviews, standards | Quality & Security |
| devops | Sonnet | CI/CD, Docker, infra, deployment | Infrastructure & Delivery |
| perf | Sonnet | Profiling, benchmarking, optimization | Infrastructure & Delivery |
| docs | Haiku | API docs, guides, technical writing | Documentation |
| researcher | Sonnet | Deep research, information synthesis | Architecture & Planning |

### Communication Protocol

**Activity Log** (agents → dashboard):
- File: `.claude/agent-activity.log` (append-only JSONL)
- Format: `{"timestamp": "ISO8601", "agent": "name", "status": "active|complete|idle|error|awaiting_orders", "task": "description", "model": "opus|sonnet|haiku"}`

**Command Queue** (dashboard → agents):
- File: `.claude/agent-commands.json` (JSON array)
- Format: `{"id": "cmd_xxx", "target": "agent|all", "text": "command", "priority": "low|normal|high|critical", "timestamp": "ISO8601", "source": "operator|fleet-command", "acknowledged": false}`

### WebSocket Bridge

`agent-bridge.js` runs a zero-dependency Node.js WebSocket server on port 27182:
- Watches the activity log and pushes new entries to connected dashboards in real time
- Accepts command writes from the dashboard and atomically appends to the command queue
- Falls back gracefully — dashboard polls via fetch every 3 seconds when bridge is offline

### Shell Scripts

**Log activity:**
```bash
./.fleet/log-agent-activity.sh <agent> <status> <"task description"> [model]
./.fleet/log-agent-activity.sh backend active "Building auth endpoints" sonnet
```

**Send command:**
```bash
./.fleet/write-agent-command.sh <target> <"command text"> [priority]
./.fleet/write-agent-command.sh backend "Refactor auth to JWT" high
./.fleet/write-agent-command.sh all "Run full test suite" critical
```

**Launch everything:**
```bash
./.fleet/start-dashboard.sh
```

## Dashboard Features

### 3D Deep Space Interface
- Full Three.js WebGL scene with starfield parallax, nebula, gas giant, debris
- 10 agent nodes as hexagonal panels in a 3D fleet formation
- Status indicators: cyan=active, grey=idle, amber=awaiting orders, blue=complete, red=error
- Animated conduit connections between related agents with particle flow
- Click to select agents, Shift+click for multi-select

### Command Console
- Click any agent to open its command console
- Issue orders with priority levels (Low/Normal/High/Critical)
- Quick-action template chips per agent role
- View task history and previous commands
- Broadcast to all agents via the Quick Broadcast input

### HUD
- Fleet status bar: active count, missions complete, anomalies
- Live COMMS LOG with last 50 events
- Bridge connection status indicator
- Activity sparkline

## File Structure

```
├── CLAUDE.md                          # This file
├── .fleet/                            # Fleet dashboard (self-contained)
│   ├── agent-dashboard.html           # 3D command dashboard (single file, zero build)
│   ├── agent-bridge.js                # WebSocket bridge server (zero deps)
│   ├── log-agent-activity.sh          # Agent logging script
│   ├── write-agent-command.sh         # Command queue writer
│   ├── start-dashboard.sh             # Launch script
│   ├── launch-agent.sh               # Agent launcher with lifecycle hooks
│   ├── agent-lifecycle.sh            # Lifecycle event handler
│   ├── package.json                  # Node.js deps (ws only)
│   └── node_modules/
└── .claude/
    ├── agent-activity.log             # Activity log (JSONL)
    ├── agent-commands.json            # Command queue (JSON array)
    └── agents/                        # Agent definitions
        ├── architect.md
        ├── backend.md
        ├── frontend.md
        ├── database.md
        ├── qa.md
        ├── security.md
        ├── reviewer.md
        ├── devops.md
        ├── perf.md
        └── docs.md
```

## Agent Instructions

Every agent must:
1. **On start**: Run `./.fleet/log-agent-activity.sh <name> active "<task>" <model>`
2. **Check commands**: Read `.claude/agent-commands.json` for unacknowledged commands targeting them or "all"
3. **Execute commands**: Process by priority (critical > high > normal > low), log with command_id
4. **On complete**: Run `./.fleet/log-agent-activity.sh <name> complete "<task>" <model>`
5. **When idle**: Run `./.fleet/log-agent-activity.sh <name> awaiting_orders "Standing by" <model>`
