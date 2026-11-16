/**
 * RFMD P5 (Gate 1 addendum docs/security/2026-11-07-gate1-rfmd-p5-models.md, M4, M5, M6, M10): the pinned generation models, their API, size, person control and token units.
 * Code constants, not config: no config write can swap in another (pricier or looser) model. No aliases, no `-latest`. Changing one is a code change with its own Gate.
 *
 * IMAGE: gemini-nano-banana-2.1 through models.generateContent, IMAGE modality only, 1K. No person control is sent (see OD-5i below).
 * VIDEO: gemini-omni-1.2-flash on the Interactions API has NO person control (OD-5 undecided, M5), so video is OFF: the tool is not registered (VIDEO_ENABLED is false).
 */
export const IMAGE_MODEL = { id: 'gemini-nano-banana-2.1', api: 'generateContent', imageSize: '1K', tokensPerImage: 1120 } as const;
/**
 * OD-5i (owner-accepted risk, 2026-11-07, Gate 1 addendum M5 for images): the pinned image model has NO usable person control. @google/genai 2.32.0 refuses
 * `imageConfig.personGeneration` in Gemini Developer API mode, so the field is NOT sent. In its place: (1) EVERY image_generate call needs an approval card showing the whole
 * prompt and the cost, tainted or not; (2) a fixed code-held instruction is appended to the prompt text (IMAGE_PERSON_SUFFIX); (3) the real-person denylist, the strictest safety
 * settings (BLOCK_LOW_AND_ABOVE), duty gating and the caps stay. Residual risk accepted by the owner: GENERIC people may still appear in a picture (the suffix is weak: the
 * model may ignore it). Revisit when the SDK or API offers a person control.
 */
export const IMAGE_PERSON_SUFFIX = 'Do not depict any real or identifiable person: no faces of real persons, no likeness of any real individual, no celebrities, politicians or public figures.';
/**
 * M3/M6: output tokens the call may produce, sent as maxOutputTokens and used as the reservation ceiling. A 1K image is 1,120 tokens, so 2,048 leaves room for it.
 * NEEDS A LIVE CHECK that a 1K image fits under it, and whether maxOutputTokens also bounds thought tokens. If the model hits the cap (finish reason MAX_TOKENS) the call
 * fails closed: no image is posted, it is settled from usage, and it is never retried with a higher cap.
 */
export const IMAGE_MAX_OUTPUT_TOKENS = 2048;
export const VIDEO_MODEL = { id: 'gemini-omni-1.2-flash', api: 'interactions', resolution: '720p', tokensPerSecond: 5792, personControl: 'none: OD-5 undecided' } as const;
/** M5: video stays off until the owner decides OD-5 and the Interactions client exists. Fail closed. */
export const VIDEO_ENABLED = false;
/** Models that are shut down: a pin equal to one of these is a bug (tested). */
export const RETIRED_MODEL_IDS: readonly string[] = ['imagen-4.0-generate-001', 'imagen-3.0-generate-002', 'imagen-3.0-generate-001', 'veo-2.0-generate-001', 'veo-3.0-generate-001', 'gemini-omni-1.1-flash'];
export const IMAGE_ASPECTS = ['1:1', '3:4', '4:3', '9:16', '16:9'] as const;
export const VIDEO_ASPECTS = ['16:9', '9:16'] as const;
/** M6: 3 to 8 seconds, always sent explicitly. */
export const VIDEO_SECONDS = { min: 3, max: 8 } as const;
/** Two images are two sequential provider calls (M6): one image per call. */
export const MAX_IMAGES_PER_CALL = 2;
/** Discord's default upload limit is 10 MB; the result must fit in one message. */
export const MEDIA_MAX_BYTES = 10_000_000;
/** M11: a job older than this is failed. */
export const VIDEO_JOB_LIFETIME_MS = 15 * 60_000;
/** M9: hosts a result download may touch on any hop. Exact names only (the .googleusercontent.com suffix is gone). */
export const DOWNLOAD_HOSTS: readonly string[] = ['generativelanguage.googleapis.com', 'storage.googleapis.com'];
/** M3: tokens the reservation assumes for the prompt plus the fixed suffix (at most 400 characters of user text). */
export const PROMPT_TOKEN_CAP = 2048;
export const VIDEO_OUTPUT_EXTRA_TOKENS = 65_536;
/** M10: how long a models.get answer is trusted. */
export const AVAILABILITY_TTL_MS = 6 * 3_600_000;
