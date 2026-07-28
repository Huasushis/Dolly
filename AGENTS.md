# Repository Instructions

## Naming and terminology

Use established technical and domain terms with their conventional meanings.
Do not invent a project-specific name, synonym, abbreviation, metaphor, or
compound term when plain language or an established term already describes the
same thing.

When a genuinely project-specific term is unavoidable, define it in plain
language at its first authoritative use before relying on the term. The
definition must state:

1. the concrete object, state, or action the term names;
2. how it relates to concepts already used in Dolly; and
3. why an established term is not sufficient.

This rule applies to source identifiers, types, classes, file names, error
codes, schema names, configuration keys, protocols, specifications, tests, and
user-facing documentation, as well as agent plans, reviews, progress reports,
and handoffs. A wire identifier is still required to have a plain-language
explanation; the identifier is not its own definition.

Expand an abbreviation on first use. Use one term for one concept across code,
tests, specifications, and the user interface (UI). Do not give the same
concept different names in different layers, and do not reuse one name for
different concepts.

If a proposed abstraction cannot be explained accurately in one or two plain
sentences, do not add it. Simplify the design or use direct, descriptive names
instead. Existing unexplained Dolly terminology is not grandfathered: when it
is touched, either replace it with an established term or add the missing
definition and keep its use consistent.

Before finishing a change, review every newly introduced term. Remove or rename
unnecessary coined language and add a nearby explanation for every unavoidable
project-specific term. User-facing text must lead with plain language and put
literal code or schema identifiers in backticks only after the explanation.
