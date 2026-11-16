-- Reply and forward (docs/security/2026-11-03-gate1-rfmd.md RF4, RF10, RF11). Additive only.
-- bot_messages.answer: the message was posted as a run's answer to a person or task (set by the scheduler's deliver() only). Only such a message
-- can be replied to (the reply route); cards, notices and bot talk keep answer = false. Rows that predate this stay false: a reply to an old
-- message does not route (fail closed).
ALTER TABLE bot_messages ADD COLUMN answer boolean NOT NULL DEFAULT false;
-- tasks.forwards: on a ROOT task, how many forward_to child tasks its tree has taken (the per-root cap is taken with a conditional UPDATE, not count-then-create).
ALTER TABLE tasks ADD COLUMN forwards integer NOT NULL DEFAULT 0 CHECK (forwards >= 0);
-- tasks.forward_card: set on a task made by forward_to: 'full' = the cards show the summary, 'link' = the cards show the source link and a fixed line only
-- (the target room can be seen by people who cannot see the source). The real text stays in description for the owner's run.
ALTER TABLE tasks ADD COLUMN forward_card text CHECK (forward_card IN ('full','link'));
