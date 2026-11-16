import { DERIVED, classOf } from './manifest/catalog.js';
import type { AutopilotDecision } from './types.js';

/**
 * AUTO-1 (AP-C1, Gate 1 F-1): the ONLY tools whose OWN approval reason (a `requiresApproval` answer that is not the boolean `false`) project autopilot may waive. R4: a frozen view of the checked-in
 * manifest (autopilot 'own_waive'; V7 limits it to a non-sensitive tool with a kind). A new tool, a config value or model text can never join it: joining needs a manifest entry AND the same
 * diff in tools/manifest/privileged.json, both protected from bot self-modification (devjob NON_SELF_MODIFIABLE). Any other tool with its own reason keeps its card.
 */
export const AUTOPILOT_OWN_WAIVE: readonly string[] = DERIVED.ownWaive; // R4: a frozen view of the manifest (autopilot 'own_waive')

/** SA-1 5.3: the fixed refusal texts of the autopilot branch. None echoes input or model text. */
export const AUTOPILOT_REFUSAL: Readonly<Record<Extract<AutopilotDecision, { kind: 'refuse' }>['code'], string>> = Object.freeze({
  url_heuristic: 'Refused in this project: the url looks like it carries data. Use a plain address without query data, or another source. No card was sent.',
  query_heuristic: 'Refused in this project: the search looks like it carries data (over 200 characters, a run of 20+ characters, 10+ digits, an @, a secret or hidden characters). Search with a few plain words. No card was sent.',
  masked_input: 'Refused in this project: the call contains a secret. Remove it and try again. No card was sent.',
  input_cut: 'Refused in this project: a text field is over 4000 characters. Shorten it and try again. No card was sent.',
});

/** AUTO-2 (SA-1 5.5): the same fixed texts for a company tree ("Refused under company autopilot:"). The audit outcome stays `autopilot_refused:<code>`. */
export const AUTOPILOT_REFUSAL_COMPANY: Readonly<Record<keyof typeof AUTOPILOT_REFUSAL, string>> = Object.freeze(
  Object.fromEntries(Object.entries(AUTOPILOT_REFUSAL).map(([k, v]) => [k, v.replace('Refused in this project:', 'Refused under company autopilot:')])) as Record<keyof typeof AUTOPILOT_REFUSAL, string>);

/**
 * AUTO-1 (Gate 1 table "Still a card"): comments are free text posted to an outside system, so they keep their card inside a project even where the code declares them `write`
 * (the ClickUp comment tool has its own reason, which AUTOPILOT_OWN_WAIVE leaves out). R4: a frozen view of the manifest (autopilot 'always_card'); `decide` reads `isAlwaysCard` (the class, which fails closed: an undeclared name is a card too) before anything else.
 */
export const AUTOPILOT_ALWAYS_CARD: readonly string[] = DERIVED.alwaysCard; // R4: a frozen view of the manifest (autopilot 'always_card')
/** R4: a denial reads the class, which fails closed: an undeclared name is always a card. */
export const isAlwaysCard = (name: string): boolean => classOf(name).autopilot === 'always_card';
