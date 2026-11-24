<div align="center">

# 🏢 Employee

### An AI software company that lives in your Discord server

**20 AI teammates** · each one its own bot · real roles, real departments, real approvals

![version](https://img.shields.io/badge/version-0.2.0--rc-blue)
![python](https://img.shields.io/badge/python-3.12+-3776AB?logo=python&logoColor=white)
![discord](https://img.shields.io/badge/Discord-py--cord-5865F2?logo=discord&logoColor=white)
![models](https://img.shields.io/badge/models-Claude%20%2B%20Gemini-D97757)
![db](https://img.shields.io/badge/storage-SQLite-003B57?logo=sqlite&logoColor=white)

[What it does](#-what-it-does) ·
[Meet the team](#-meet-the-team) ·
[Approvals](#-approvals) ·
[Commands](#-commands) ·
[Quick start](#-quick-start) ·
[Docs](#-docs) ·
[Roadmap](#-roadmap)

</div>

---

## ✨ What it does

> You talk to the team on Discord, the same way you would talk to real colleagues.

| | |
| :---: | :--- |
| 💬 | **Chat with anyone.** Mention a persona by name and that persona answers as itself. Every persona is a separate bot. |
| 🧭 | **Praw handles the front door.** She is in every room, listens and routes your request to the right department head. |
| 📋 | **Work is handed down.** Heads take orders in the HQ lounge and give their team coded tasks, such as `DEV-0001`. |
| ✅ | **Nothing risky happens without approval.** Small decisions go to the department's AI head. Big ones go to humans. |
| ⌨️ | **It feels natural.** You see "*is typing…*", then one finished reply. |
| 📟 | **Logs stay quiet and tidy.** Only the System bot posts in `#bot-log`, and only warnings and errors. |

### How a request flows

```text
  👤 You
   │
   ▼
  🧭 Praw ─────────► 👔 Department head ─────────► 🧑‍💻 Team member
  (intake)            (plans, delegates)            (does the work)
                                                         │
                                         needs approval? ▼
                                ┌────────────────────────┴────────────────────────┐
                                ▼                                                 ▼
                     🏷️ Department level                                 🏛️ HQ level
                     AI head decides                              Humans (AI-Admin) decide
                     dept approvals channel                         HQ approvals channel
```

---

## 👥 Meet the team

Department heads are in **bold**.

<table>
<tr>
<td valign="top" width="50%">

**🏛️ Leadership**
- 🧭 **Praw** (พราว): intake assistant
- 👑 **Mira** (มีรา): executive, COO-style

**💻 Engineering**
- **Tek** (เทค): tech lead
- Bank (แบงค์): backend
- Fon (ฝน): frontend
- Dew (เดฟ): DevOps
- Qin (คิว): QA
- Anan (อนันต์): security & compliance

**🎨 Product & Data**
- **Pim** (ปิ่น): product
- **Nicha** (ณิชา): design
- **Kawin** (กวิน): data & analytics

</td>
<td valign="top" width="50%">

**⚙️ Operations**
- **Ploy** (พลอย): operations
- **Phupha** (ภูผา): IT
- **Pat** (ปัตตี้): procurement

**📑 Business**
- **Mali** (มะลิ): accounting
- **Thara** (ธารา): legal
- **Fahsai** (ฟ้าใส): HR

**📣 Growth & Customers**
- **Somo** (ส้มโอ): marketing
- **Bass** (เบส): sales
- **Sai** (สายชล): customer support

</td>
</tr>
</table>

<details>
<summary>🧠 Which model does each persona use?</summary>

| Model | Personas |
| :--- | :--- |
| Claude Opus | Mira, Tek, Anan, Pim, Phupha, Ploy, Pat, Thara, Sai |
| Claude Sonnet | Bank, Fon, Dew, Qin, Nicha, Kawin, Mali |
| Claude Haiku | Fahsai |
| Gemini Flash | Praw, Somo, Bass |

Every persona also has a cheaper fallback model, used when its daily budget runs low. Persona files are in [`prompts/<dept>/`](prompts/).

</details>

---

## 🗺️ Discord layout

| Room | Who is inside | Used for |
| :--- | :--- | :--- |
| 🤖 **BOT** category | One room per persona | Talking to one persona directly |
| 🏷️ **Department** categories | That department's team + Praw | Daily work and the department's own approvals |
| 🏛️ **HQ** | Executives + each room's team | Big decisions and HQ approvals |
| 🛋️ **HQ lounge** | Senior staff, executives, secretary | Giving orders that flow down to each team |
| ⚙️ **setting** | AI-Admin | `/setting` commands |
| 📟 **bot-log** | System bot only | System warnings and errors |

> 🔒 Bots see nothing by default. Each room gives access deliberately.

---

## ✅ Approvals

Every task and every request gets a **code**. You can look it up, edit it or cancel it.

```text
Tasks       DEV-0001   FIN-0042   HR-0003
Approvals   APR-FIN-0007          APR-HQ-0001
```

| | 🏷️ Department level | 🏛️ HQ level |
| :--- | :--- | :--- |
| **Who decides** | The department's AI head | Humans with the **AI-Admin** role |
| **Where** | Department approvals channel | HQ approvals channel |
| **When** | Normal work inside one department | Dangerous actions · more than **10,000 THB** · across departments · escalated by a head |

- 🛡️ **When unsure, it goes to HQ.** If the classifier is unsure or offline, the request goes up to humans.
- 📝 **Cards are detailed.** Each one shows what, why, the cost, who asked and what it touches.
- 🗂️ **Nothing is lost.** Cancelling keeps the history, and every decision is written to the audit log.

---

## ⌨️ Commands

| Command | What it does |
| :--- | :--- |
| `/task show` · `edit` · `cancel` | Look up or change a task by its code |
| `/approval show` · `cancel` | Look up or withdraw an approval request |
| `/setting view` · `set` · `reset` | Tune live settings, such as the threshold. AI-Admin only, in ⚙️ setting |
| `/budget view` · `set` | Daily budget per persona |
| `/voice …` | Voice features. Off by default |

> 💡 `.env.local` holds the fixed values. `/setting` holds the values you tune from Discord.

---

## 🚀 Quick start

**You need:** Python 3.12+ · a Discord server · one Discord app per persona ([guide](docs/helper/discord-apps.md)) · an Anthropic API key · a Google AI key

```bash
# 1️⃣  Install
python3.12 -m venv .venv && .venv/bin/pip install -e .

# 2️⃣  Configure (fill in your own values; never commit this file)
cp .env.example .env.local && chmod 600 .env.local

# 3️⃣  Try it offline (no Discord, no API calls)
scripts/dev-local.sh --fake

# 4️⃣  Bring the team online
scripts/dev-discord.sh
```

| | |
| :--- | :--- |
| 📄 Logs | `~/.local/share/employee-dev/discord/logs/app.jsonl` |
| 🧪 Tests | `.venv/bin/pytest -q` (no network or keys needed) |

<details>
<summary>⚙️ Main settings in <code>.env.local</code></summary>

| Group | Variables |
| :--- | :--- |
| Bots | `DISCORD_BOT_TOKEN_<PERSONA>`, `DISCORD_APP_ID_<PERSONA>` |
| Models | `ANTHROPIC_API_KEY` (a workspace key, `sk-ant-api03-…`), `GOOGLE_API_TOKEN` |
| Server | `DISCORD_GUILD_ID`, `CHANNEL_ALLOWLIST`, `TASKS_CHANNEL_ID`, `APPROVAL_CHANNEL_ID`, `SETTINGS_CHANNEL_ID` |
| Approvals | `APPROVER_ROLE_NAME` (never `@everyone`) |
| Feel | `STREAM_MODE` = `typing` (default) or `edit` |
| Storage | `DATABASE_PATH`: absolute path, outside the repo |

[`.env.example`](.env.example) lists every variable.

</details>

<details>
<summary>📁 Project layout</summary>

```text
core/        🧠 engine · providers · tasks · approvals · settings · Discord
prompts/     🎭 one main prompt per persona, by department
knowledge/   📚 shared knowledge store
deploy/      🚢 VPS install script · systemd · backups
scripts/     🛠️ dev-local.sh · dev-discord.sh
tests/       🧪 unit + acceptance tests
docs/        📖 PRD · specs · security reviews · guides
```

</details>

---

## 📖 Docs

| | Topic | Link |
| :---: | :--- | :--- |
| 🗂️ | Start here: index of all docs | [docs/_index.md](docs/_index.md) |
| 🎯 | Product requirements | [PRD](docs/prd/2026-11-23-ai-team-prd.md) |
| 🏗️ | Architecture | [architecture.md](docs/development/architecture.md) |
| 🎭 | Persona file format | [persona-format.md](docs/development/persona-format.md) |
| 💻 | Local development | [local-dev.md](docs/helper/local-dev.md) |
| 🤖 | Creating the Discord apps | [discord-apps.md](docs/helper/discord-apps.md) |
| 🚢 | VPS deploy & restore | [setup.md](docs/helper/setup.md) |
| 📐 | Specs | [docs/specs/](docs/specs/_index.md) |
| 🔐 | Security reviews | [docs/security/](docs/security/) |

---

## 🛣️ Roadmap

- ✅ **v0.1, Core.** Engine, tools, knowledge, budgets, CLI
- 🔄 **v0.2, Discord.** 20 bots, System log bot, coded tasks and approvals, ⚙️ setting, typing indicator *(live testing)*
- 🌱 **v0.3, Growth.** Two parts:
  - 📈 **The team learns from its work.** Reviewed lessons go into a secondary prompt that is versioned and can be rolled back. AI **never** edits a main prompt.
  - 🏗️ **The company can grow.** Use `/hire`, `/fire`, `/move` and `/dept add` from ⚙️ setting.

---

## 🔐 Security

- 🔑 **Secrets stay out of the repo.** They live only in `.env.local` (mode 0600, git-ignored), and this README never shows them.
- 🙈 **Tokens are masked** in replies, logs and `#bot-log`.
- 🚪 **Access is opt-in.** Bots get no server-wide view; each room grants access.
- 🧑‍⚖️ **Humans approve HQ-level actions.** The approver role can never be `@everyone`.
- 🛡️ **Two security reviews per change:** one on the spec before building, one on the code before release.