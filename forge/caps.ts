/** R7 PLUGIN-FORGE: every cap is a constant here (spec 5.10, rule 11: none depends on another configurable cap). */
export const ZIP_MAX_ENTRIES = 200;
export const ZIP_MAX_FILE = 512 * 1024;
export const ZIP_MAX_TOTAL = 4 * 1024 * 1024;
export const SHIPPED_MAX_FILES = 120;
export const SHIPPED_MAX_BYTES = 2 * 1024 * 1024;
export const VENDOR_MAX_BYTES = 1.5 * 1024 * 1024;
export const FORGE_JSON_MAX = 2 * 1024;
export const PACKAGE_JSON_MAX = 16 * 1024;
export const LOCK_MAX = 1024 * 1024;
export const JSON_MAX_DEPTH = 32;
export const PATH_MAX = 200;
export const PATH_MAX_DEPTH = 6;
export const TITLE_MAX = 80;
export const DEV_DEPS_SHOWN = 20;

export const FORGES_OPEN_MAX = 3;
export const BUILDS_PER_FORGE = 3;
export const BUILDS_PER_DAY = 3;
export const IMAGES_KEPT_MAX = 8;
export const MAX_ATTEMPTS = 3;
export const IMAGE_DELTA_MAX = 8 * 1024 * 1024;
export const BUILD_DEADLINE_MS = 180_000;
export const QUEUE_TTL_DAYS = 7;
export const GC_DISABLED_DAYS = 7;
export const GC_UNSTAGED_HOURS = 1;
export const TICK_MS = 30_000;
export const GC_MS = 10 * 60_000;

export const EXEC_MS = { inspect: 15_000, create: 30_000, cp: 60_000, commit: 60_000, rm: 30_000 } as const;
