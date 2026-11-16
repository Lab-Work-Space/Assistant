/**
 * LEARN-1 R3: starter team skills, one to two per department (none for praw). Written from the department head prompts and the audit error
 * counts only (never notes, room entries or task titles), so this text is trusted code. Tool names used here are limited to each
 * department's own frontmatter list. Edits are deliberate: seed-data.test.ts pins a sha256 of the whole list.
 */
export interface SeedSkill {
  id: string;
  dept: string;
  title: string;
  instructions: string;
  templates?: { name: string; body: string }[];
}

const UPDATE_TASK_ID =
  'When you call update_task, copy the full task id from the open-task header, or at least its first 8 characters. Do not retype an id from memory and do not use the task title in its place.';

export const SEED_SKILLS: readonly SeedSkill[] = [
  {
    id: 'hq-delegate-and-decide',
    dept: 'hq',
    title: 'Delegate with a complete create_task and record each decision',
    instructions: [
      'Delegate with create_task. Fill every field in one call: a short clear title, a due date, the acceptance criteria (how we will know it is done) and an estimate. Name the one department that owns the work. If a field is unknown, ask_requester first instead of leaving it empty or guessing.',
      'When a question needs a decision from you, decide, write the decision and its reason in one or two sentences, and attach it to the task with update_task. Do not leave a choice open in the room.',
      UPDATE_TASK_ID,
      'After a tool call, say what it returned. If it returned an error, say so and fix the input; do not report the work as done.',
    ].join('\n\n'),
  },
  {
    id: 'hq-decision-summary',
    dept: 'hq',
    title: 'Summarise decisions taken in a fixed short form',
    instructions: [
      'When you report to the requester or close a meeting, list the decisions taken, not the discussion. One line per decision: what was decided, who owns it, the due date. Then list what is still open and who must answer. Use only facts from the tasks and the knowledge base; mark anything you could not confirm as unconfirmed.',
      'Use forward_to only with a department id or a member id that exists, and say in one line why you pass it on. Use warroom_say for short status lines; keep long text in the task or the document.',
    ].join('\n\n'),
    templates: [
      {
        name: 'Decision summary',
        body: 'Decisions taken:\n- <decision> | owner: <dept or member> | due: <date>\nStill open:\n- <question> | needs an answer from: <who>\nUnconfirmed:\n- <fact we could not check>',
      },
    ],
  },
  {
    id: 'software-workspace-discipline',
    dept: 'software',
    title: 'One workspace per product, pinned installs, test claims backed by output',
    instructions: [
      'Keep one workspace per product; reuse it and do not create a second one for the same product. Create it before the first file is written.',
      'Install packages with exact versions (package name plus exact version, such as 1.2.3), never a range and never latest. Prefer npm ci when a lockfile exists.',
      'Run tests and the type check in the workspace and read the result. Report a test or build as passed only when the run result shows exit code 0; quote the exit code and the key output lines. If the run failed or did not happen, say so plainly and give the first error.',
      'If a workspace command returns a tool error, read the message, change the input and try once more; if it fails again, mark the task blocked with the error text instead of retrying in a loop.',
    ].join('\n\n'),
  },
  {
    id: 'software-task-handoff',
    dept: 'software',
    title: 'Keep tasks current with update_task and hand work over with a clear note',
    instructions: [
      UPDATE_TASK_ID,
      'Update the task when its state changes: started, blocked (say on what), ready for review, done. A done update names what was built, where it lives in the workspace, and how it was checked.',
      'Give create_task a title, a due date, acceptance criteria and an estimate. Acceptance criteria are checkable statements such as "npm test exits 0 and the new endpoint returns 201", not wishes.',
      'When you are blocked, use resolve_blocked or ask_requester with one precise question; include the exact error message. Use warroom_say for one-line status only.',
    ].join('\n\n'),
  },
  {
    id: 'rnd-search-and-verify',
    dept: 'rnd',
    title: 'Search with short plain queries, read the source, mark unverified numbers',
    instructions: [
      'Web search works best with short plain queries of three to six words. Do not paste a full sentence, a question with quotes, or operators. If a search returns nothing useful, change the words, not the length, and try again at most twice.',
      'A search result is only a pointer. Open the result page to read it before you rely on it, and note the page title and the date it shows.',
      'Mark every number or claim you did not read in a source as unverified, and say which source supports each verified one. Do not round a figure into a stronger claim than the source made.',
      'Give each research task a due date, acceptance criteria and an estimate. When a document is created, supply a title and a non-empty body. If a tool returned an error, report the error text.',
    ].join('\n\n'),
  },
  {
    id: 'rnd-experiment-brief',
    dept: 'rnd',
    title: 'Frame an idea as a cheap test with a clear pass condition',
    instructions: [
      'Before an idea is promised to anyone, write the smallest test that could show it is wrong: the hypothesis, the cheapest way to test it, the measure and the pass condition, and the time box. Hand the test out with create_task and keep its estimate small.',
      'Report results as: what we tried, what we measured, what it means, what we do next. Say clearly when the result is inconclusive. Use kb_search first to see whether the team already tried the idea.',
      'If you need a new capability, use tool_request with the exact need and one example of how you would use it.',
    ].join('\n\n'),
    templates: [
      {
        name: 'Experiment brief',
        body: 'Hypothesis: <one sentence>\nCheapest test: <what to do>\nMeasure and pass condition: <number or observation>\nTime box: <days>\nUnverified assumptions: <list>',
      },
    ],
  },
  {
    id: 'it-triage-with-evidence',
    dept: 'it',
    title: 'Triage with the exact error, one question at a time, and a verified fix',
    instructions: [
      'Start each support request by asking for the exact error message, what the person was doing, and when it began. Use ask_requester for one precise question at a time, not a list of ten. Use kb_search to see whether this problem has a known fix.',
      'Open a task with create_task for any work that takes more than a quick answer: title, due date, acceptance criteria (the symptom is gone and how we checked) and an estimate.',
      UPDATE_TASK_ID,
      'Prefer the boring fix that is easy to undo. Say what you changed and what the check returned. If a tool returned an error, report it as it was and do not claim the problem is solved.',
    ].join('\n\n'),
  },
  {
    id: 'ops-purchase-request-checklist',
    dept: 'ops',
    title: 'Run vendor and purchase work from a checklist with dates and amounts',
    instructions: [
      'For each purchase or vendor job, record in the task: what is needed, quantity, the budget limit, the needed-by date, and who receives it. Ask the requester for any missing item with ask_requester before comparing vendors.',
      'Compare at least two options when the amount is large and write down price, delivery time and what is included. Give the figures as the vendor stated them and mark any estimate as an estimate.',
      'Create work with create_task: title, due date, acceptance criteria (for example "goods received and counted") and an estimate. Close the loop with update_task using the full task id or its first 8 characters, saying what happened and what is left.',
    ].join('\n\n'),
  },
  {
    id: 'sales-honest-pipeline',
    dept: 'sales',
    title: 'Answer from known facts and keep deal tasks current',
    instructions: [
      'Before you state a price, a feature or a delivery date to a customer, check it with kb_search. If the knowledge base does not confirm it, say you will confirm it and open a task for the owner instead of guessing.',
      'Record each deal step with update_task: stage, next step, next date. Use the full task id from the open-task header or its first 8 characters.',
      'When an outside page or search would help, name the question first; if a tool returned an error, say so and use what you already know, labelled as unconfirmed.',
    ].join('\n\n'),
  },
  {
    id: 'sales-quote-handoff',
    dept: 'sales',
    title: 'Hand a quote request to the right team with every detail in create_task',
    instructions: [
      'For a quote or proposal request, collect the customer need, scope, budget range and deadline with ask_requester. Then use create_task for the department that prepares it: title, due date, acceptance criteria (what the quote must contain) and an estimate.',
      'Use forward_to for a message that belongs to another department and say why in one line. Keep the customer-facing text short, plain and free of promises that are not in the task.',
    ].join('\n\n'),
  },
  {
    id: 'hr-hiring-task-flow',
    dept: 'hr',
    title: 'Run hiring and onboarding as tasks with named steps and dates',
    instructions: [
      'Turn each hiring or onboarding job into a task with create_task: the position or person, the steps, a due date for each, acceptance criteria (for example "offer sent and answer recorded") and an estimate. Ask the requester with ask_requester when headcount, level or start date is missing.',
      'Keep personal details out of the room. Share only what the next person needs to act, and refer to a candidate by role and stage.',
      UPDATE_TASK_ID,
      'Report progress as stage counts and the next date. If a tool returned an error, say so and do not report the step as done.',
    ].join('\n\n'),
  },
  {
    id: 'finance-show-arithmetic',
    dept: 'finance',
    title: 'Show the arithmetic, state assumptions, report only confirmed figures',
    instructions: [
      'Show every calculation: inputs, the formula, the result, the currency and the period. State each assumption on its own line. Round only at the last step and say how.',
      'Take figures from the task or kb_search; if a figure is missing, ask_requester for it. Mark an estimate as an estimate and a confirmed figure with its source.',
      'Create finance work with create_task: title, due date, acceptance criteria (for example "totals match the source report") and an estimate. Update it with update_task using the full task id or its first 8 characters, and state what the tool returned.',
    ].join('\n\n'),
  },
  {
    id: 'marketing-content-brief',
    dept: 'marketing',
    title: 'Brief content work with audience, goal and a measure',
    instructions: [
      'Before content is made, write a brief: audience, goal, channel, key message, due date and the measure of success. Ask the requester with ask_requester if audience or goal is missing. Use kb_search for brand facts rather than inventing them.',
      'Hand the work out with create_task: title, due date, acceptance criteria (for example "draft under 150 words, one call to action") and an estimate.',
      'When a document is created, give it a title and a non-empty body. Report results with the numbers and their source, and mark any figure you did not check as unverified.',
    ].join('\n\n'),
    templates: [
      {
        name: 'Content brief',
        body: 'Audience: <who>\nGoal: <one outcome>\nChannel: <where>\nKey message: <one sentence>\nDue: <date>\nMeasure: <number and source>',
      },
    ],
  },
  {
    id: 'marketing-campaign-report',
    dept: 'marketing',
    title: 'Report campaign results with figures, source and next action',
    instructions: [
      'Report campaign results in four lines: what ran and when, the figures (with their source and period), what we learned, and the next action with an owner and a date. Compare against the target in the brief.',
      'Do not turn a small change into a trend; say the sample is small when it is. Mark any figure you could not confirm as unverified.',
      UPDATE_TASK_ID,
    ].join('\n\n'),
  },
];
