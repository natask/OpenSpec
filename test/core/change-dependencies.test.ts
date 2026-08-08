import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findDependencyCycles,
  formatDependencyCycle,
} from '../../src/core/validation/change-dependencies.js';
import { Validator } from '../../src/core/validation/validator.js';

describe('change dependency cycle detection', () => {
  it('returns deterministic representatives for cyclic components', () => {
    const graph = new Map<string, readonly string[]>([
      ['zeta', ['alpha']],
      ['echo', ['delta']],
      ['charlie', ['bravo', 'missing-change']],
      ['alpha', ['zeta']],
      ['bravo', ['charlie']],
      ['delta', ['echo']],
    ]);

    expect(findDependencyCycles(graph)).toEqual([
      ['alpha', 'zeta', 'alpha'],
      ['bravo', 'charlie', 'bravo'],
      ['delta', 'echo', 'delta'],
    ]);
  });

  it('detects a self-cycle and formats actionable guidance', () => {
    const [cycle] = findDependencyCycles(new Map([['solo', ['solo']]]));

    expect(cycle).toEqual(['solo', 'solo']);
    expect(formatDependencyCycle(cycle)).toBe(
      'Dependency cycle detected: solo -> solo. Remove one dependsOn entry to break the cycle.'
    );
  });

  it('ignores acyclic edges and missing targets', () => {
    expect(findDependencyCycles(new Map([
      ['alpha', ['missing-change']],
      ['bravo', ['alpha']],
    ]))).toEqual([]);
  });
});

describe('cycle-aware change validation', () => {
  const projectRoot = path.join(process.cwd(), 'test-change-cycle-tmp');
  const changesDir = path.join(projectRoot, 'openspec', 'changes');

  beforeEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('fails each change in a cycle with the same deterministic error', async () => {
    await writeChange('charlie', ['alpha'], true);
    await writeChange('alpha', ['bravo'], true);
    await writeChange('bravo', ['charlie'], true);

    const validator = new Validator();
    const alphaReport = await validator.validateChangeDeltaSpecs(path.join(changesDir, 'alpha'));
    const charlieReport = await validator.validateChangeDeltaSpecs(path.join(changesDir, 'charlie'));
    const expectedMessage =
      'Dependency cycle detected: alpha -> bravo -> charlie -> alpha. Remove one dependsOn entry to break the cycle.';

    expect(alphaReport.valid).toBe(false);
    expect(charlieReport.valid).toBe(false);
    expect(alphaReport.issues).toContainEqual({
      level: 'ERROR',
      path: 'dependsOn',
      message: expectedMessage,
    });
    expect(charlieReport.issues).toContainEqual({
      level: 'ERROR',
      path: 'dependsOn',
      message: expectedMessage,
    });
  });

  it('does not apply a cycle error to an unrelated active change', async () => {
    await writeChange('alpha', ['bravo']);
    await writeChange('bravo', ['alpha']);
    await writeChange('independent', []);

    const report = await new Validator().validateChangeDeltaSpecs(
      path.join(changesDir, 'independent')
    );

    expect(report.valid).toBe(true);
    expect(report.issues).not.toContainEqual(expect.objectContaining({ path: 'dependsOn' }));
  });

  async function writeChange(
    id: string,
    dependsOn: readonly string[],
    reverseDependencies = false
  ): Promise<void> {
    const changeDir = path.join(changesDir, id);
    const specDir = path.join(changeDir, 'specs', 'example');
    await fs.mkdir(specDir, { recursive: true });
    await fs.writeFile(path.join(changeDir, 'proposal.md'), `# ${id}\n`);
    const dependencies = reverseDependencies ? [...dependsOn].reverse() : dependsOn;
    await fs.writeFile(
      path.join(changeDir, '.openspec.yaml'),
      `schema: spec-driven\ndependsOn:\n${dependencies.map(value => `  - ${value}\n`).join('')}`
    );
    await fs.writeFile(
      path.join(specDir, 'spec.md'),
      `## ADDED Requirements

### Requirement: Example
The system SHALL remain valid.

#### Scenario: Example
- **WHEN** validation runs
- **THEN** it passes
`
    );
  }
});
