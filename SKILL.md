---
name: lumina-lang
description: Teach AI agents how to read, write, and reason about .lm files — the Actor Model architecture definition language. Use when designing .lm types, modules, interfaces, or system composition; when generating implementation code from Task JSON; or when explaining Lumina concepts.
---

# Lumina Language Skill

## What Lumina Is

Lumina is NOT a programming language. It's an **architecture definition language**. `.lm` files describe a system as a collection of actors that communicate through JSON messages. There is no control flow, no implementation logic, and no runtime behavior in the language itself.

Your job as an AI is to:
1. **Read** `.lm` files and understand the system architecture they describe
2. **Write** `.lm` files that define types, modules, and system composition
3. **Generate** implementation code from Task JSON (the compiler's intermediate representation)

## Language Syntax

### File Structure

A `.lm` file is a sequence of imports, type definitions, and module definitions:

```
import "path/to/file.lm" as alias

type TypeName = type_expression ("semantic description")?

module ModuleName {
    actor? setup? interface? logic?
}
```

### Imports

```rust
import "types.lm" as t
import "db/postgres.lm" as db
```

The alias becomes a namespace. Reference imported definitions with `alias.Name`.

### Type Definitions

```
type Name = TypeExpr ("description")?
```

**TypeExpr variants:**

| Variant | Syntax | Example |
|---------|--------|---------|
| Primitive | `Int`, `Float`, `String`, `Bool` | `Int("user ID")` |
| Generic | `List<T>`, `Map<K,V>` | `List<Float>("scores")` |
| Record | `{ "key": Type, ... }` | `{ "id": Int, "name": String }` |
| Union | `TypeA \| TypeB` | `{ "ok": Int } \| { "err": String }` |
| Qualified | `alias.TypeName` | `t.DataPacket` |

Every type component can carry a semantic description string in `()`:

```rust
type User = {
    "id": Int("primary key"),
    "email": String("verified contact email")
}("user account record")
```

These descriptions are **first-class language constructs**, not comments. They appear in the AST and are passed to AI code generation agents as implementation context.

### Module Definitions

```rust
module ModuleName {
    actor actor_name: Alias.ModuleType    // mount child actor
    setup: "natural language setup description"
    interface: {
        "method_name": { input_fields } -> { output_fields }
    }
    logic: "natural language behavior description"
}
```

**Rules:**
- `actor` can appear multiple times (one per child actor)
- `setup`, `interface`, `logic` appear at most once each
- A module with no `interface` is a spontaneous actor — it only sends messages, never receives them
- The `interface` maps method names (strings) to input→output record type pairs
- All sections are optional (an empty module is valid, though useless)

### Comments

```rust
// Single-line comments are supported
```

## Design Philosophy

### Actors Are Black Boxes

Each module is an isolated actor. It exposes:
- `run()` — called once at startup (derived from `setup`)
- `invoke(method, params)` — the single message entry point (derived from `interface`)

The AI generating implementation code must ONLY implement these two methods. It must NOT:
- Import or instantiate other modules directly
- Make assumptions about the global system topology
- Add public methods beyond the interface contract

### Semantic Strings Drive Implementation

When generating code from a Task JSON, the semantic descriptions are your primary guidance:

- `Int("unique timestamp ID")` → use a timestamp-based ID generator
- `"allocate a memory pool for high-frequency sorting"` → pre-allocate buffers, avoid allocations in hot paths
- `"non-recursive quicksort"` → implement iterative quicksort, not recursive

Write implementation code that **matches the semantic intent**, not just the type signature.

### Message Passing Is Everything

All inter-actor communication goes through `send_message(target, method, params)`. Even in monolith mode where actors are in the same process, the interface is the same. This ensures that code generated for one mode works in the other without changes.

## Writing Good .lm Files

### Type Design

- Use `Int`, `Float`, `String`, `Bool` for primitives. Always add a description.
- Use `List<T>` for homogeneous collections. Use records for structured data.
- Use unions (`|`) for fallible results (success payload | error info).
- Group related fields into named record types.
- Cross-reference types from other files with `import` + qualified names.

### Module Design

- One module = one responsibility. If your `logic` says "do A, then B, then C", consider splitting.
- Start with the `interface` — what messages does this actor handle?
- Write `logic` as a concise natural-language description of the algorithm/behavior.
- Use `setup` for initialization: connections, memory allocation, timer setup.
- Mount child actors with `actor` instead of reimplementing their functionality.

### System Composition

- Put shared types in a `types.lm` file.
- Put each module in its own file if it has significant logic.
- Use `main.lm` as the composition root — it mounts actors and defines the top-level flow.
- The entry point module typically has no `interface` (it's a spontaneous orchestrator).

## Common Patterns

### Request-Response Module

```rust
module Calculator {
    interface: {
        "add": { "a": Int, "b": Int } -> { "result": Int }
        "multiply": { "a": Int, "b": Int } -> { "result": Int }
    }
    logic: "perform the specified arithmetic operation and return the result"
}
```

### Stateful Module

```rust
module SessionStore {
    setup: "open a connection to Redis at localhost:6379"
    interface: {
        "get": { "key": String } -> { "value": String }
        "set": { "key": String, "value": String } -> { "ok": String }
    }
    logic: "implement get/set using the Redis connection from setup"
}
```

### Pipeline Orchestrator

```rust
module Pipeline {
    actor stage1: workers.Parser
    actor stage2: workers.Validator
    actor stage3: workers.Storage

    setup: "start listening on port 8080 for incoming data"

    logic: "receive data → stage1.parse → stage2.validate → stage3.store"
}
```

### Fallible Operation

```rust
type ParseResult = {
    "intent": String,
    "confidence": Float
} | {
    "error": String("human-readable error message")
}
```

## Constraints When Generating Implementation

When you receive a Task JSON and are asked to generate implementation code:

1. **Implement ONLY the assigned module.** Do not write code for other modules.
2. **Override `run()` and `invoke(method, params)`.** These are the only entry points.
3. **Use `self.send_message(actor_name, method, params)` for child actors.** Never call them directly.
4. **Match the interface contract exactly.** Input/output JSON must conform to the schemas.
5. **Return valid JSON from `invoke()`.** The output must be a dict matching the output schema.
6. **Handle all interface methods.** If a method is listed, it must be implemented.
7. **Use the semantic descriptions.** They tell you *how* to implement, not just *what*.
