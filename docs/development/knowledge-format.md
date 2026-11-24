---
title: "Knowledge store — file and index format"
doc_id: "DOC-DEV-002"
version: 1.1.0
status: "Draft"
last_updated: 2026-11-24
author: Document Writer Agent
referenced_plan: "docs/plans/2026-11-23-phase1-plan.md"
---

# Knowledge store — file and index format

## Contents

- [1. Model](#1-model)
- [2. Layout](#2-layout)
- [3. Areas](#3-areas)
- [4. Index line](#4-index-line)
- [5. Entry file](#5-entry-file)
- [6. Visibility and reads](#6-visibility-and-reads)
- [7. Slug and write rules](#7-slug-and-write-rules)
- [8. Paths and errors](#8-paths-and-errors)
- [9. Retention and erasure](#9-retention-and-erasure)
- [10. Storage and backups (VPS)](#10-storage-and-backups-vps)
- [11. Related documents](#11-related-documents)

> Status (2026-11-24): store and tools built (`core/knowledge/store.py`, `core/agent_tools/knowledge.py`); `knowledge/` has 14 department areas plus `memory`, `notes`, `drafts`, `rules`, `meetings` and templates, mostly empty. Section 10 describes current VPS storage and backups (SQLite, native systemd, no Docker; spec §11). The rules below are the build contract from spec §3.9, §10.8 and §10.10.

## 1. Model

The knowledge store is plain markdown on disk. There is no vector database in phase 1 (PRD §6.7). Agents read the index first and open only the entries that match. No tool lists a directory and no tool reads a whole area.

## 2. Layout

```text
KNOWLEDGE_DIR/
  <area>/_index.md        one line per entry
  <area>/<slug>.md        one file per entry
  _template/<area>.md     entry template for the area (optional)
```

`KNOWLEDGE_DIR` is set in the environment (default `knowledge`, spec §5.7).

## 3. Areas

| Area | Writable by agents | Notes |
| :-- | :-- | :-- |
| `memory` | yes, through `knowledge_write` | Agent memory. Seeded (TASK-014). |
| `notes` | yes, through `knowledge_write` | Free notes. Seeded by TASK-014 (`notes/_index.md`, `_template/notes.md`). |
| `rules` | **no** (`area_read_only`) | Edited by humans only. |
| `meetings` | no (`area_read_only`) | Voice meeting notes, written only by internal code (`on_done`, `core/voice/session.py`). Voice is off unless `VOICE_ENABLED=true`. Entries are restricted by visibility (section 6). |

The writable set is `{"memory", "notes"}` (spec §10.8.1). Areas must already exist. A missing area gives `area_not_found`.

## 4. Index line

Each entry has one line in its area's `_index.md`:

```text
- [Title](slug.md) — hook | tag1, tag2
```

- `Title` and `hook` are stripped of `]`, `(`, `)` and newlines before writing (spec §3.9).
- For a restricted entry (section 6) the hook is replaced:

```text
- [Title](slug.md) — (restricted) | tag1, tag2
```

- `knowledge_search` reads index lines only. A restricted entry therefore cannot expose transcript text through search (spec §10.10.1).
- `read_index` of a missing index returns an empty string. A write creates a missing `_index.md` for an existing area (spec §10.10.5).

## 5. Entry file

Every entry written through `write_entry` has these frontmatter keys (spec §10.8.2):

```yaml
---
title: "<title>"
tags: [<tag>, <tag>]
created: <ISO date>
author_agent: "<agent id>"
run_id: "<run id>"
trigger: "<trigger name>"
human_user_id: <int or null>
visibility: "public"
---
```

- `visibility` is `public`, or `members:<id>,<id>,...` where each id matches `^[0-9]{1,20}$`. Any other value is treated as `members:` with an empty list (restricted to approvers only).
- The body follows the area template (`_template/<area>.md`) when it exists. Without a template the body is the entry text.
- Content read from knowledge is wrapped as untrusted text before it reaches a model (spec §3.9, §6.2).

## 6. Visibility and reads

`knowledge_read` of a `members:` entry is allowed only when one of these holds (spec §10.10.1):
- the human who triggered the run is in the list;
- the human actor is an approver (`ApproverPolicy.is_approver`).

It is never allowed when there is no human (`human_user_id` is null). A denied read returns `not_found`, so existence is not revealed.

Every file open is logged as `knowledge.open agent=<id> run=<run_id> area=<area> file=<name>`. For the index, `file` is `_index.md`.

## 7. Slug and write rules

- `slug = slugify(title)`. Duplicates get `-2`, `-3`, and so on.
- An empty slug becomes `entry-<first 8 chars of run_id>` before the suffix rule (spec §10.8.4).
- A per-area lock serialises writes. The entry is written to a temp file and moved into place with `os.replace`. The index is rewritten the same way (spec §3.9).
- Each write logs `knowledge.write area file agent`.
- `knowledge_write` requires a human trigger (`needs_human_trigger=True`). With no human id it returns `needs_human` (spec §10.8.3).

## 8. Paths and errors

| Code | When |
| :-- | :-- |
| `invalid_path` | After `realpath`, the path is not under the area root, or the area or file is a symlink. |
| `area_not_found` | Area folder does not exist. |
| `area_read_only` | Write to an area outside the writable set. |
| `needs_human` | Write without a human trigger. |
| `not_found` | File missing, or a denied restricted read. |

## 9. Retention and erasure

- `KnowledgeStore.purge_older_than(area, days)` deletes entries whose `created` date is older than `days`, and their index lines. The daily sweeper calls it for `meetings` with `KNOWLEDGE_MEETINGS_RETENTION_DAYS` (default 90) (spec §10.10.3).
- `delete_entry(area, file)` removes one entry.
- `erase_user(area, file, user_id)` removes every transcript line of that user, removes the user from `visibility`, and replaces the `## Summary` section with `Summary removed after an erasure request.`, drops the `## Contents` block (it lists Summary sub-headings, which are model text), and sets `human_user_id: null` when it equals the erased user (provenance, S1212-04) (spec §10.10.4).
- Transcript lines use `<display name> [<user_id>]: <text>`, so erasure matches the exact token `[<user_id>]:`.
- Erasure through Discord is an approver-only command (Slice B).

## 10. Storage and backups (VPS)

- Knowledge dir on the VPS: `/var/lib/employee/knowledge`, set by `KNOWLEDGE_DIR` in `deploy/employee.service`. It is owned by the `employee` user, mode 0700 (spec §11).
- `deploy/install.sh` seeds it once from the checked-out `knowledge/` tree with `cp -r --update=none`, so existing files are not overwritten.
- Git: `/knowledge/meetings/*` is ignored and `knowledge/meetings/.gitkeep` is kept (`.gitignore`).
- Backups: the local backup (`python -m core.db.backup`, into `backups/` next to `DATABASE_PATH`) copies the SQLite DB only; it does not include the knowledge dir. Hostinger VPS snapshots capture `/var/lib/employee/knowledge`, transcripts included (spec §11 privacy notice). No off-host backup exists yet (spec §11 OQ-3).
- Contents: on write, a `## Contents` block is prepended when the body is over 4 KB or has 3 or more headings (`add_contents`, `core/knowledge/store.py`). Do not write it by hand.
- Reads: `knowledge_read` with `section=<id or heading>` returns one part. Without `section` it returns Contents plus the first section. `full=true` returns the whole entry (max 64 KB per read).

## 11. Related documents

- Store design: spec §3.9, §10.8, §10.10
- Architecture: `docs/development/architecture.md`
- Env names: `docs/helper/setup.md`
