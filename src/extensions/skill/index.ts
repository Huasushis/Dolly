/**
 * Dolly Skill extension baseline.
 *
 * Scope
 * -----
 * This package turns an Agent Skills-compatible directory into a bounded,
 * deterministic catalog and renders that catalog as one Module description (the
 * "premise" in the owner's original wording). It hot reloads by asking the
 * runtime for a serialized actor Run; it never writes a description itself.
 *
 * Owner requirement `OWNER-SKILL-001`
 * (`docs/takeover/confirmed-user-requirements.md`), from
 * `.qoder/specs/dolly_new.txt` section "Skill模块": use the most primitive
 * approach, only change the premise and do nothing else; do not call a model to
 * judge whether to inject; do not adapt manual skill execution, because the
 * model can read the file itself; follow the Agent Skills standard; watch the
 * directory or check periodically for hot reload.
 *
 * Deliberately not implemented
 * ----------------------------
 * These are absences by decision, not gaps left for later in this baseline:
 *
 * 1. No model or provider call anywhere. Nothing ranks, scores, selects, or
 *    rewrites skills, and no embedding is computed. The whole catalog index
 *    goes into the description and the reading model decides for itself.
 * 2. No manual skill execution interface. There is no run, invoke, dispatch, or
 *    remote procedure call for a skill, and no adapter that turns a skill into
 *    a tool or a Block method.
 * 3. No execution authority of any kind. The extension never spawns a process,
 *    runs a script from `scripts/`, evaluates a template, or opens a network
 *    connection. The `allowed-tools` front matter field is parsed and dropped:
 *    per `docs/spec/skill-extension.md` section 3, a file-reading or Bash tool
 *    for the model is an independent deployment grant, and skill text can never
 *    create one.
 * 4. No file reading beyond each candidate `SKILL.md`. Files under `scripts/`,
 *    `references/`, and `assets/` are neither read, digested, counted, nor
 *    described; a model with its own granted file tool lists and reads them.
 * 5. No scoped skill resource read capability (`skill-extension.md` section 8)
 *    and no catalog administration input description (section 7, last
 *    paragraph). Both are deferred contract surface.
 * 6. No production wiring. Nothing here is registered with
 *    `runtime-bootstrap.ts` or the Extension process host, and configured
 *    Modules remain rejected by the runtime.
 *
 * Trust
 * -----
 * Skill text is untrusted data. The rendered description says so, and a
 * consumer such as the LLM extension is responsible for delimiting it under its
 * own prompt trust policy (`docs/spec/core-runtime.md` section 9.2.1).
 */

export {
  AGENT_SKILLS_FORMAT_ID,
  AGENT_SKILLS_FORMAT_REVISION,
  MAX_COMPATIBILITY_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  SKILL_ENTRY_FILE_NAME,
  decodeSkillText,
  parseSkillFrontmatter,
} from "./skill-frontmatter.js";
export type {
  SkillFrontmatter,
  SkillFrontmatterFailure,
  SkillFrontmatterFailureCode,
  SkillFrontmatterResult,
  SkillFrontmatterSuccess,
  SkillTextResult,
} from "./skill-frontmatter.js";

export {
  DEFAULT_SKILL_SCAN_LIMITS,
  SkillScanError,
  scanSkillLibrary,
} from "./skill-catalog.js";
export type {
  SkillCatalog,
  SkillCatalogEntry,
  SkillRejection,
  SkillRejectionCode,
  SkillScanErrorCode,
  SkillScanLimits,
  SkillScanOptions,
} from "./skill-catalog.js";

export {
  DEFAULT_MAX_LISTED_IDENTIFIERS,
  DEFAULT_SKILL_DESCRIPTION_BYTES,
  MIN_SKILL_DESCRIPTION_BYTES,
  SkillDescriptionError,
  renderSkillModuleDescription,
} from "./skill-description.js";
export type {
  SkillDescriptionErrorCode,
  SkillDescriptionOptions,
} from "./skill-description.js";

export { SkillRefreshError, SkillRefreshScheduler } from "./skill-refresh.js";
export type {
  SkillRefreshErrorCode,
  SkillRefreshReason,
  SkillRefreshSchedulerOptions,
  SkillRefreshState,
  SkillRefreshStatus,
  SkillRefreshTimerCancel,
  SkillSourceActivationRequest,
} from "./skill-refresh.js";

export { watchSkillLibrary } from "./skill-library-watcher.js";
export type {
  SkillLibraryWatcher,
  SkillLibraryWatcherOptions,
} from "./skill-library-watcher.js";
