---
name: lettuce-memory-and-system-prompt
description: 'lettuce memory mechanics: `agent.system` is a letta-code-managed preset tracked by hash and version (editing it opts the agent out of refreshes and no agent tool can write it), while what an agent rewrites is persona.md in its memfs repo, surfaced in the Memory tab, not Agent → General; the memfs repo location, the fact that no toolset can write memory (0.34.7 added a read-only `Memory` tool for memfs-v2 agents), `letta memory` having no write verb, and the background memory worker. the Memory pane's two views (folder tree and link graph) and why its edges are upstream's `references[]`. Read before answering "it updated its system prompt but the UI shows the old one", touching bff/src/agents memory rendering or `web/src/lib/memory-graph.ts`, or any memory/ persona or frontmatter validation work.'
---

# Agent memory and the two system prompts

Loaded from `AGENTS.md`. Two different things are called "the system prompt" and memory lives outside every agent workspace.

- **Two different things are called "the system prompt", and an agent can only change one.**
  `agent.system` — what Agent → General shows — is a letta-code-**managed** preset, tracked in
  `settings.json` as `systemPromptPreset` + `systemPromptHash` + `systemPromptVersion`;
  `scheduleManagedSystemPromptUpdate` (`agent/system-prompt-versioning.ts`) overwrites `system`
  with the new preset text on a version bump while the hash still matches. Editing it flips the
  agent to `systemPromptPreset: "custom"` and opts it out of every future refresh. No agent
  tool writes this field. What an agent rewrites when asked to change its own instructions is
  `memory/system/persona.md` in its memfs (0.33.3+ agents get the flat "root MemFS" layout
  instead: `persona.md` at the repo root plus a `MEMORY.md` index, detected by that index)
  (`/data/local-backend/memfs/<agent-id>/memory/`, a git repo — `git log` there is the
  provenance). That block is composed into context every turn when `memfs: true`, and the UI
  surfaces it in the **Memory** tab, not Agent → General. Expect "I asked it to update its
  system prompt and the UI shows the old one" — both statements are true and about different
  fields.
- **Memory lives outside every agent workspace, and agents write it with ordinary file tools.**
  The memfs repo is `/data/local-backend/memfs/<agent-id>/memory` (`$MEMORY_DIR` in the agent's
  shell env) — never under `/work/<agent-id>`. Since letta-code 0.33 the in-process `memory`
  tool (and `memory_apply_patch`) is in **no toolset** (`tools/toolset-catalog.ts`); its code
  still exists but no agent can call it. What 0.34.7 added back is `Memory` — read-only
  discovery of deferred memfs-v2 memory (`path` → that dir's `MEMORY.md` plus its children),
  present only when the agent's memory dir is memfs-v2 with a root `MEMORY.md`, and it cannot
  write anything. Agents still write with plain `Edit`/`Write`/`Bash` on
  `$MEMORY_DIR` (the file tools pass the cross-agent guard for the agent's own memory; shells
  are unconfined), and the repo's `pre-commit`/`post-commit` hooks validate frontmatter.
  Incidental upkeep and post-turn git conflict repair go to a background memory worker (a
  registered subagent — internals: docs/upstream-notes.md#memory-worker-internals).
  `letta memory` (the CLI) has status/diff/backup/export/pull but **no write verb** — its own
  help says "use git commands" — so an agent that goes looking there finds nothing and
  concludes memory is unwritable.
- **The Memory pane is two views of one `list_memory` listing, and its links are upstream's.**
  Tree (folders first, alphabetical, top level collapsed) or graph (`web/src/lib/memory-graph.ts`,
  derived in the SPA — there is no graph command upstream). The graph asks `list_memory` with
  `include_references: true` and draws what comes back: letta-code
  (`websocket/listener/commands/memory.ts`) owns the `[[wiki link]]` grammar, resolves aliases and
  `.md` inference, and **drops a target that does not exist** — so a dangling link is invisible
  rather than broken, and the SPA deliberately has no second parser to disagree with that. Note
  references are extracted from the body **after frontmatter is stripped**: a `[[link]]` in
  frontmatter is not an edge. Files with no links are off the picture by default (the bar counts
  them), and the force layout is our own — seeded, one run per change of file-set, with the pass
  count shrinking as memory grows (`layoutIterations`) because the freeze is the thing to bound.
