<!--
SYNC IMPACT REPORT
==================
Version change: 1.0.0 → 1.1.0
Modified principles: None
Added sections: None (structural revision only)
Modified sections:
  - Spec Rules — replaced with the actual standard from
    https://niziming.github.io/2026/03/24/Spec%E6%A8%A1%E5%BC%8F%E5%BC%80%E5%8F%91/#41-spec-%E6%96%87%E4%BB%B6%E7%9A%84%E6%A0%87%E5%87%86%E7%BB%93%E6%9E%84
    (YAML frontmatter + 9 numbered sections: Overview, Goals & Non-Goals,
    Detailed Design, Technical Constraints, Error Handling, Acceptance
    Criteria, Context References, Open Questions, Changelog). The first
    draft of this section (1.0.0) was written before the URL was fetched
    and used a User-Story/FR-XXX/SC-XXX shape instead — superseded.
Removed sections: None
Templates checked:
  - .specify/templates/plan-template.md ✅ Constitution Check section present; no changes needed
  - .specify/templates/spec-template.md ⚠ pending — still uses User Stories
    (P1/P2/P3) + FR-XXX/SC-XXX, NOT the frontmatter/9-section structure
    mandated by Spec Rules. Left as-is by explicit user decision: the
    speckit-specify/speckit-tasks/speckit-plan/speckit-clarify skills are
    load-bearing on the User Story shape (e.g. speckit-tasks organizes
    generated tasks BY user-story priority; speckit-specify's quality
    checklist is keyed to it). Reconciling would require redesigning that
    pipeline, not just editing a template — out of scope for this
    amendment. Spec Rules documents the intended standard; the existing
    spec pipeline is a documented, deliberate exception until reworked.
  - .specify/templates/tasks-template.md ⚠ pending — same reason as above
    (organizes by user story, which the new Spec Rules structure has no
    equivalent for)
Deferred TODOs:
  - Reconcile spec-template.md + speckit-{specify,tasks,plan,clarify,analyze}
    skills with the Spec Rules structure, or explicitly ratify the User
    Story shape as a permanent project-specific deviation in a future
    amendment.
-->

# Dolly Constitution

## Core Principles

### I. Code Quality (NON-NEGOTIABLE)

All code MUST pass `pnpm typecheck` before merge. Code MUST be readable,
well-named, and free of dead code or commented-out blocks. Security MUST be
enforced: no command injection, XSS, SQL injection, or other OWASP Top 10
vulnerabilities. No debug artifacts or temporary hacks are permitted in
committed code. If a security vulnerability is introduced, it MUST be fixed
immediately before the work is considered done.

### II. Testing Standards (NON-NEGOTIABLE)

Every feature or bug fix MUST include corresponding tests. Tests MUST be run
and pass before any commit. Tests MUST cover the happy path AND critical edge
cases. Integration tests MUST use real dependencies — mocks are only permitted
when unavoidable and MUST be documented with justification. "Tests pass" is
not the same as "feature works": end-to-end validation against a running
instance MUST be performed for user-facing changes.

### III. Reusability

Code MUST be written to be composable and DRY across modules. Shared logic
MUST be extracted into utilities or core modules rather than duplicated. Three
similar lines is better than a premature abstraction, but five or more MUST
trigger extraction. Modules MUST expose clear, stable interfaces; internal
implementation details MUST NOT leak across module boundaries.

### IV. Scalability

Architecture decisions MUST consider future extension points. No hardcoded
limits, magic numbers, or tight coupling that would prevent scaling. Every
design decision MUST be answerable to: "How does this behave when 10× the
data, users, or modules are added?" Extensibility is the first priority — any
design that forecloses user customization MUST be rejected or explicitly
justified.

### V. Modularity

Every capability MUST be implemented as a `DollyModule` conforming to the
standard interface (`init` / `onBlocksChanged` / `systemPrompt` / `onStop` /
`onStart` / `handleCli`). Modules MUST be independently loadable, testable,
and removable without affecting other modules. Cross-module dependencies MUST
be explicit, minimal, and declared — implicit coupling is prohibited.

## Security Requirements

It is STRICTLY PROHIBITED for any agent, automation, or tooling to
proactively access or read secret or credential files (`.env`, `*.key`,
`credentials.*`, private key files, token stores, etc.) within the project
directory without an explicit, in-session user instruction.

A mandatory secret leakage check MUST be performed before every commit:
- Inspect all staged files for API keys, tokens, passwords, or private
  credentials before running `git commit`.
- Secret and credential files MUST be listed in `.gitignore` and MUST NEVER
  be staged or committed under any circumstances.
- If a staged file's content is uncertain, inspect it by key name only —
  never echo secret values in output or responses.

## Development Workflow

Every change MUST follow this sequence:

1. Update `docs/` (architecture, module, config docs affected by the change)
2. Implement the code change
3. Run `pnpm typecheck` — MUST pass
4. Validate against the test checklist
5. Perform secret leakage check on all staged files
6. `git commit`

Spec files MUST follow the Spec Rules defined below. Commit messages MUST be
descriptive and reference the feature, fix, or scope of change.

## Spec Rules

Spec files MUST follow the standard structure defined at
[Spec 模式开发 §4.1](https://niziming.github.io/2026/03/24/Spec%E6%A8%A1%E5%BC%8F%E5%BC%80%E5%8F%91/#41-spec-%E6%96%87%E4%BB%B6%E7%9A%84%E6%A0%87%E5%87%86%E7%BB%93%E6%9E%84):

**Frontmatter** — every spec MUST begin with a YAML frontmatter block
delimited by `---`, containing: `title`, `spec_id` (e.g. `SPEC-2026-001`),
`version` (semver), `status` (`draft | in-review | approved | implemented |
deprecated`), `author`, `created`, `updated`, `tags` (array), `priority`
(`P0`–`P3`), and `dependencies` (list of Spec IDs this one relies on).

**Body** — MUST contain these nine sections, in order, as numbered H2
headings (e.g. `## 1. Overview`), under a single H1 title of the form
`# {Feature Name} Spec`:

1. **Overview** — what the feature is and why it's needed; 1-3 paragraphs
   of business context and motivation.
2. **Goals & Non-Goals** — what will be achieved; explicit out-of-scope
   items to prevent scope creep.
3. **Detailed Design** — functional description, data models, API designs
   (request/response formats), and flow diagrams.
4. **Technical Constraints** — stack requirements covering performance,
   security, and compatibility.
5. **Error Handling** — handling strategy for each exception/error scenario.
6. **Acceptance Criteria** — verifiable conditions in Given-When-Then format.
7. **Context References** — related file paths, external services, and
   design documents.
8. **Open Questions** — unresolved items and points pending discussion.
9. **Changelog** — table of date, version, description, and author for each
   change.

**Format rules**: Markdown (`.md`); code blocks embed JSON examples, SQL
schemas, or flow diagrams; tables are used for structured comparisons
(status, versions, constraints). Unresolved requirements MUST be captured
under Open Questions rather than left implicit. Requirements language: use
MUST for non-negotiable requirements, SHOULD for strong preferences — the
word "should" alone (uncapitalised) is insufficient and MUST be replaced.

## Governance

This constitution supersedes all other development guidelines and CLAUDE.md
conventions where they conflict. CLAUDE.md governs project-specific runtime
guidance; this constitution governs process, standards, and principles.

Amendment procedure:
- Any principle change requires documenting the motivation, incrementing the
  version per semantic versioning (MAJOR: removal/redefinition of a principle;
  MINOR: new principle or material expansion; PATCH: wording/clarification),
  and updating `LAST_AMENDED_DATE`.
- All PRs and code reviews MUST verify compliance with each principle above.
- Violations MUST be documented in the Complexity Tracking section of the
  relevant `plan.md` with explicit justification for why the simpler
  compliant approach was insufficient.

**Version**: 1.1.0 | **Ratified**: 2026-07-04 | **Last Amended**: 2026-07-04
