---
title: "Persona file format"
doc_id: "DOC-DEV-003"
version: 1.1.0
status: "Draft"
last_updated: 2026-11-24
author: Document Writer Agent
referenced_plan: "docs/plans/2026-11-23-phase1-plan.md"
---

# Persona file format

## Contents

- [1. Location and loading](#1-location-and-loading)
- [2. Frontmatter keys](#2-frontmatter-keys)
- [3. Errors](#3-errors)
- [4. Body](#4-body)
- [5. Praw: required edits (TASK-020)](#5-praw-required-edits-task-020)
- [6. Related documents](#6-related-documents)

> Status (2026-11-24): built. The loader `core/agents/persona.py` (TASK-007) and the 20 persona files under `prompts/` follow this page. Praw's edits in section 5 are done. Source of truth: spec §5.2.

## 1. Location and loading

- Path: `PROMPTS_DIR/<dept>/<Name>.md`, where `PROMPTS_DIR` defaults to `prompts`.
- Files in folders are loaded, except directories and files whose names start with `_`. Those are `_fragments/` and `_system/`.
- The folder name carries no meaning. Praw stays at `prompts/assistant/Praw.md`.
- The frontmatter is parsed with a safe YAML loader only.

## 2. Frontmatter keys

| Key | Required | Rule |
| :-- | :-- | :-- |
| `id` | yes | `^[a-z][a-z0-9_-]{1,31}$`, unique. Praw is `praw`. |
| `name` | yes | 1 to 80 characters. Must not contain `discord` or `clyde` (case-insensitive). |
| `aliases` | yes | 1 to 10 items, each 2 to 32 characters. After normalisation they are unique across all personas, including other personas' `name`. |
| `role` | yes | 1 to 300 characters. |
| `dept` | yes | `^[a-z][a-z0-9_-]{1,31}$`. |
| `model` | yes | `^(anthropic\|google\|gemini)/[A-Za-z0-9._-]{1,64}$`. |
| `cheap_model` | no | Same pattern as `model`. Default is `DEFAULT_CHEAP_MODEL`. |
| `effort` | yes | `low`, `medium` or `high`. |
| `tools` | yes | Items match `^(\*\|[a-z][a-z0-9_]{0,62}(_\*)?)$`. Unknown tool names log a WARNING. |
| `traits` | yes | List of strings. |
| `color` | yes | `^#[0-9A-Fa-f]{6}$`. |
| `avatar` | no | `https://` URL, at most 512 characters. |
| `fragments` | yes | Items match `^[a-z][a-z0-9-]{0,31}$`. Each `prompts/_fragments/<name>.md` must exist. |

Example of the key layout only (values are illustrative):

```yaml
---
id: "example"
name: "Example"
aliases: ["example", "ex"]
role: "One-line role, 1 to 300 characters"
dept: "assistant"
model: "gemini/<model-id>"
cheap_model: "gemini/<model-id>"
effort: "medium"
tools: ["*"]
traits: ["concise"]
color: "#F48FB1"
fragments: ["delegation", "report-format"]
---
```

Model ids are never hard-coded in the system. Builders confirm the current ids from each provider's model list (spec §5.7).

## 3. Errors

- Any rule failure refuses that one persona and logs an ERROR. The other personas still load.
- A missing `DEFAULT_AGENT_ID` persona, or an alias collision, aborts startup.

## 4. Body

The spec does not define required body sections. Praw uses headings for the persona text and the reply rules. Treat those headings as the current convention, not as a validated schema. Prompts are built from files and metadata only, and they are checked for secrets (spec §6.1 T2).

## 5. Praw: required edits (TASK-020)

Done. `prompts/assistant/Praw.md` now has `id: praw`, `aliases: ["พราว","praw","น้องพราว"]`, `cheap_model: gemini/gemini-3.8-flash` and `fragments: [delegation, asking, approval-request, report-format]`. The four fragment files exist in `prompts/_fragments/` (TASK-019). The replacement of the first "How you work here" bullet from spec §5.2 is not re-checked in this page; check it against the spec when you edit Praw.

## 6. Related documents

- Spec: `docs/specs/2026-11-23-phase1-spec.md` §5.2, §3.0
- Architecture: `docs/development/architecture.md`
- Env names: `docs/helper/setup.md`
