# change-creation Specification

## Purpose
Provide programmatic utilities for creating and validating OpenSpec change directories.
## Requirements
### Requirement: Change Creation
The system SHALL provide a function to create new change directories programmatically.

#### Scenario: Create change
- **WHEN** `createChange(projectRoot, 'add-auth')` is called
- **THEN** the system creates `openspec/changes/add-auth/` directory

#### Scenario: Duplicate change rejected
- **WHEN** `createChange(projectRoot, 'add-auth')` is called and `openspec/changes/add-auth/` already exists
- **THEN** the system throws an error indicating the change already exists

#### Scenario: Creates parent directories if needed
- **WHEN** `createChange(projectRoot, 'add-auth')` is called and `openspec/changes/` does not exist
- **THEN** the system creates the full path including parent directories

#### Scenario: Invalid change name rejected
- **WHEN** `createChange(projectRoot, 'Add Auth')` is called with an invalid name
- **THEN** the system throws a validation error

### Requirement: Change Name Validation
The system SHALL validate change names follow kebab-case conventions.

#### Scenario: Valid kebab-case name accepted
- **WHEN** a change name like `add-user-auth` is validated
- **THEN** validation returns `{ valid: true }`

#### Scenario: Numeric suffixes accepted
- **WHEN** a change name like `add-feature-2` is validated
- **THEN** validation returns `{ valid: true }`

#### Scenario: Single word accepted
- **WHEN** a change name like `refactor` is validated
- **THEN** validation returns `{ valid: true }`

#### Scenario: Uppercase characters rejected
- **WHEN** a change name like `Add-Auth` is validated
- **THEN** validation returns `{ valid: false, error: "..." }`

#### Scenario: Spaces rejected
- **WHEN** a change name like `add auth` is validated
- **THEN** validation returns `{ valid: false, error: "..." }`

#### Scenario: Underscores rejected
- **WHEN** a change name like `add_auth` is validated
- **THEN** validation returns `{ valid: false, error: "..." }`

#### Scenario: Special characters rejected
- **WHEN** a change name like `add-auth!` is validated
- **THEN** validation returns `{ valid: false, error: "..." }`

#### Scenario: Leading hyphen rejected
- **WHEN** a change name like `-add-auth` is validated
- **THEN** validation returns `{ valid: false, error: "..." }`

#### Scenario: Trailing hyphen rejected
- **WHEN** a change name like `add-auth-` is validated
- **THEN** validation returns `{ valid: false, error: "..." }`

#### Scenario: Consecutive hyphens rejected
- **WHEN** a change name like `add--auth` is validated
- **THEN** validation returns `{ valid: false, error: "..." }`

### Requirement: Stack Metadata Scaffolding
Change creation workflows SHALL support optional dependency metadata for new or split changes.

#### Scenario: Create change with stack metadata
- **WHEN** a change is created with stack metadata inputs
- **THEN** creation SHALL persist metadata fields in change configuration
- **AND** persisted metadata SHALL be validated against change metadata schema rules

#### Scenario: Split-generated child metadata
- **WHEN** child changes are generated from a split workflow
- **THEN** each child SHALL include a `parent` link to the source change
- **AND** SHALL include dependency metadata needed for deterministic sequencing

