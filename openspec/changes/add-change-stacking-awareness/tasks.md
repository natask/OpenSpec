## 1. Metadata Model

- [x] 1.1 Add optional stack metadata fields (`dependsOn`, `provides`, `requires`, `touches`, `parent`) to change metadata schema
- [x] 1.2 Keep metadata backward compatible for existing changes without new fields
- [x] 1.3 Add tests for valid/invalid metadata and schema evolution behavior

## 2. Stack-Aware Validation

- [x] 2.1 Detect dependency cycles and fail validation with deterministic errors
- [x] 2.2 Detect missing `dependsOn` targets (referenced change ID does not exist) and detect changes transitively blocked by unresolved/cyclic dependency paths
- [x] 2.3 Add overlap warnings for active changes that touch the same capability/spec areas
- [x] 2.4 Emit advisory warnings for unmatched `requires` markers when no provider exists in active history
- [x] 2.5 Add tests for cycle, missing dependency, overlap warning, and unmatched `requires` cases

## 3. Sequencing Commands

- [x] 3.1 Add `openspec change graph` to display dependency order for active changes
- [x] 3.2 Add `openspec change next` to suggest unblocked changes in recommended order
- [x] 3.3 Add tests for topological ordering and deterministic tie-breaking (lexicographic by change ID at equal depth)

## 4. Split Scaffolding

- [x] 4.1 Add `openspec change split <change-id>` to scaffold child slices
- [x] 4.2 Ensure generated children include parent/dependency metadata and stub proposal/tasks files
- [x] 4.3 Convert the source change into a parent planning container as part of split (no duplicate child implementation tasks)
- [x] 4.4 Add tests for split output structure, source-change parent conversion, and deterministic re-split error behavior when overwrite mode is not requested
- [x] 4.5 Implement and test explicit overwrite mode for `openspec change split` (`--overwrite` / `--force`) for controlled re-splitting

## 5. Documentation

- [x] 5.1 Document stack metadata and sequencing workflow in `docs/concepts.md`
- [x] 5.2 Document new change commands and usage examples in `docs/cli.md`
- [x] 5.3 Add guidance for breaking large changes into independently mergeable slices
- [x] 5.4 Document migration guidance for `openspec/changes/IMPLEMENTATION_ORDER.md` as optional narrative, not dependency source of truth

## 6. Verification

- [x] 6.1 Run targeted tests for change parsing, validation, and CLI commands
- [x] 6.2 Run full test suite (`pnpm test`) and resolve regressions
