---
name: linear-pm
description: Manage the Linear project management layer. Query open agent:zed issues, pick up tasks, post completion comments, transition states. Use for `/linear-pm poll`, `/linear-pm status`, `/linear-pm close <issue-id>`, or when the hourly scheduled task fires.
---

# linear-pm

**Version:** 1.0.0
**Status:** ✅ Active — LINEAR_API_KEY live via OneCLI MITM proxy

## What This Skill Does

Manages the Linear project management layer. Queries open `agent:zed` issues, picks up tasks, posts completion reports as comments, and transitions issue states.

Triggered by:
- `/linear-pm poll` — check for open agent:zed issues and work them
- `/linear-pm status` — report current open issue count by project
- `/linear-pm close <issue-id>` — manually close an issue with a completion note
- Scheduled nanoclaw task (hourly cron — DEM-19)

---

## Workspace IDs (Demandgenguy / DEM)

### Team
```
Team ID:  14f2750b-2a79-47c3-805c-61bf2539e7b2
```

### Workflow States
```
Todo:        19d6bed9-461f-467b-a03d-2a0acf75dbb6
In Progress: 259f410d-9398-4454-964f-434f36edba70
In Review:   64ef3b16-ddc1-4765-ad1a-84ef49a401e9
Done:        27f3a058-a3b1-4af8-b1e0-1611da3ffc37
Blocked:     e3237ed4-22b5-4060-ae76-a14fc1aa8db9
Backlog:     9ca99a36-88c9-45f3-8fff-43194644b64f
Canceled:    16a18228-298a-41f3-9ecd-63a2d11751bc
```

### Labels
```
agent:zed:    b74aaf21-c204-49b5-a2a4-8d7b6cb1adfb
agent:human:  b677c2e7-b049-4c48-9084-6078bcc16c57
content:      f34cfb55-0621-49b0-873c-0e8f8cc096ff
strategy:     40a7ad9f-314c-4859-a2a9-d00efeba3cf6
analysis:     91c1cabf-8b46-4bee-b966-50406b280634
dev:          4e170106-0c33-4e07-86b1-480e4a4a0118
meeting-prep: 8bd70ba8-3e5a-4404-a647-2923427048c6
admin:        27d0ae85-4822-4c64-876e-d714b990fb9f
blocked:      beacc1d7-1e82-468d-bf82-a465d2662026
```

### Projects
```
Falcone Global:        1880ab14-f3af-4d30-a060-709a4d9a2b4c
Meshberg Group:        d087734e-ed73-491c-a80c-d816f2ce25e6
Cache Financials:      877420b6-203d-4526-b8f2-a27aa82c3e43
BCG RISE:              6f2e9bb1-bcad-47a9-8378-38ff819bf2e0
VNTANA:                7dc45e44-0e3a-49f7-9c2f-52851dfd406d
Meadow:                fe05f170-120e-4925-ba44-7fce92c663c8
Miller7 / SideChannel: f3fd6a75-e8ec-48a5-8039-4d8b9ef3446e
Growing Wellness:      b1ddc198-dbca-407f-8330-72cc7af075b0
CADCo:                 a7aa6e19-096a-48a2-9792-5140952b550a
Demand Gen Guy:        ac4e6b9a-34ec-4c32-ba14-4083d3d309e4
Cubby Storage:         948686ff-f912-472e-92bc-773881469f5b
_Ops:                  4447e987-b759-4db4-ba8c-6f3b581cf7b2
```

### Client Slug Mapping
```
Falcone Global         → falcone-global
Meshberg Group         → meshberg-group
Cubby Storage          → cubby-storage
Cache Financials       → cache-financials
BCG RISE               → bcg-rise
VNTANA                 → vntana
Meadow                 → meadow
Miller7 / SideChannel  → miller7
Growing Wellness       → growing-wellness
CADCo                  → cadco
Demand Gen Guy         → demand-gen-guy
_Ops                   → (infrastructure, no client folder)
```

---

## Step 1 — Poll for Open agent:zed Issues

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "{ issues(filter: { labels: { name: { eq: \"agent:zed\" } } state: { name: { nin: [\"Done\", \"Canceled\", \"Blocked\"] } } }) { nodes { id identifier title description priority state { name } project { name } labels { nodes { name } } } } }"}'
```

Sort by priority: 1 (Urgent) → 2 (High) → 3 (Medium) → 4 (Low). Pick the top issue.

---

## Step 2 — Select and Load Issue

Pick the highest-priority open `agent:zed` issue. Load title, description, project name (map to client slug above), and any blocking dependencies noted in the description.

---

## Step 3 — Transition Issue to "In Progress"

```bash
ISSUE_ID="<issue-id>"
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"mutation { issueUpdate(id: \\\"$ISSUE_ID\\\", input: { stateId: \\\"259f410d-9398-4454-964f-434f36edba70\\\" }) { success issue { state { name } } } }\"}"
```

---

## Step 4 — Execute the Work

Dispatch based on issue labels:

| Label | Action |
|-------|--------|
| `content` | Invoke `/content-writer` |
| `dev` | Direct execution (bash, file writes) |
| `analysis` | Invoke `/research-agent` |
| `meeting-prep` | Invoke `/meeting-prep` |
| `admin` | Direct execution |
| `strategy` | Flag for Brad — requires human input |

---

## Step 5 — Post Completion Report as Issue Comment

```bash
ISSUE_ID="<issue-id>"
BODY="## Completed by agent:zed\n\n**Output:** <path>\n**Notes:** <notes>\n**Next step:** <next>\n\n---\n*Completed: $(date -u +%Y-%m-%dT%H:%M:%SZ)*"
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"mutation { commentCreate(input: { issueId: \\\"$ISSUE_ID\\\", body: \\\"$BODY\\\" }) { success } }\"}"
```

---

## Step 6 — Transition to "In Review" or "Done"

- Needs Brad review → state `64ef3b16-ddc1-4765-ad1a-84ef49a401e9` (In Review)
- Autonomous, no review needed → state `27f3a058-a3b1-4af8-b1e0-1611da3ffc37` (Done)

Same curl as Step 3, swap stateId.

---

## Step 7 — Notify Brad

```
[PM] Closed: {identifier} — {title}
Project: {project}
Output: {file path}
{Blocking notes or next steps if any}
```

---

## Creating a New Issue (helper)

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"mutation { issueCreate(input: { teamId: \\\"14f2750b-2a79-47c3-805c-61bf2539e7b2\\\", projectId: \\\"<project-id>\\\", title: \\\"<title>\\\", description: \\\"<desc>\\\", priority: <1-4>, stateId: \\\"<state-id>\\\", labelIds: [\\\"<label-id>\\\"] }) { success issue { id identifier title } } }\"}"
```

---

## Error Handling

- **Blocked issue:** Post comment, leave in Blocked state, notify Brad
- **Missing client context:** Read `/workspace/extra/clients/projects/{slug}/CLAUDE.md`
- **API timeout:** Retry once, then flag to Brad

---

*Part of the Zed agent worker layer. See also: content-writer, research-agent, meeting-prep*
