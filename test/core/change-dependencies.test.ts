import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analyzeChangeDependencies,
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

  it('reports missing targets and deterministic transitive blocker paths', () => {
    const analysis = analyzeChangeDependencies(new Map([
      ['root', ['missing-direct', 'middle', 'cycle-zeta']],
      ['middle', ['leaf']],
      ['leaf', ['missing-transitive']],
      ['cycle-zeta', ['cycle-alpha']],
      ['cycle-alpha', ['cycle-zeta']],
    ]));

    expect(analysis.missingDependencies.get('root')).toEqual(['missing-direct']);
    expect(analysis.missingDependencies.get('leaf')).toEqual(['missing-transitive']);
    expect(analysis.blockedPaths.get('root')).toEqual([
      {
        kind: 'cycle',
        path: ['root', 'cycle-zeta'],
        cycle: ['cycle-alpha', 'cycle-zeta', 'cycle-alpha'],
      },
      {
        kind: 'missing',
        path: ['root', 'middle', 'leaf', 'missing-transitive'],
      },
    ]);
    expect(analysis.blockedPaths.get('middle')).toEqual([
      {
        kind: 'missing',
        path: ['middle', 'leaf', 'missing-transitive'],
      },
    ]);
  });

  it('treats archived dependency IDs as resolved', () => {
    const analysis = analyzeChangeDependencies(
      new Map([['current', ['archived-change']]]),
      new Set(['archived-change'])
    );

    expect(analysis.missingDependencies.size).toBe(0);
    expect(analysis.blockedPaths.size).toBe(0);
  });

  it('marks every member of a complex cyclic component', () => {
    const analysis = analyzeChangeDependencies(new Map([
      ['alpha', ['bravo', 'echo']],
      ['bravo', ['alpha']],
      ['echo', ['alpha']],
    ]));

    expect(analysis.cycles).toEqual([['alpha', 'bravo', 'alpha']]);
    expect([...analysis.cyclicChangeIds].sort()).toEqual(['alpha', 'bravo', 'echo']);
    expect(analysis.cycleByChangeId.get('echo')).toEqual(['alpha', 'bravo', 'alpha']);
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

  it('fails direct and transitively blocked changes with deterministic missing-target errors', async () => {
    await writeChange('root', ['middle']);
    await writeChange('middle', ['missing-change']);

    const validator = new Validator();
    const middleReport = await validator.validateChangeDeltaSpecs(path.join(changesDir, 'middle'));
    const rootReport = await validator.validateChangeDeltaSpecs(path.join(changesDir, 'root'));

    expect(middleReport.issues).toContainEqual({
      level: 'ERROR',
      path: 'dependsOn',
      message: 'Missing dependency target "missing-change" referenced by change "middle". Add or restore the change, or remove it from dependsOn.',
    });
    expect(rootReport.issues).toContainEqual({
      level: 'ERROR',
      path: 'dependsOn',
      message: 'Change "root" is transitively blocked by unresolved dependency path: root -> middle -> missing-change. Resolve the missing target before continuing.',
    });
  });

  it('fails a change transitively blocked by a dependency cycle', async () => {
    await writeChange('root', ['cycle-bravo']);
    await writeChange('cycle-bravo', ['cycle-alpha']);
    await writeChange('cycle-alpha', ['cycle-bravo']);

    const report = await new Validator().validateChangeDeltaSpecs(path.join(changesDir, 'root'));

    expect(report.issues).toContainEqual({
      level: 'ERROR',
      path: 'dependsOn',
      message: 'Change "root" is transitively blocked by cyclic dependency path: root -> cycle-bravo. Break the dependency cycle: cycle-alpha -> cycle-bravo -> cycle-alpha.',
    });
  });

  it('accepts a dependency found in date-prefixed archive history', async () => {
    await writeChange('current', ['completed-change']);
    const archivedDir = path.join(changesDir, 'archive', '2026-08-08-completed-change');
    await fs.mkdir(archivedDir, { recursive: true });
    await fs.writeFile(path.join(archivedDir, 'proposal.md'), '# completed-change\n');

    const report = await new Validator().validateChangeDeltaSpecs(path.join(changesDir, 'current'));

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
