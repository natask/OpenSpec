import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCLI } from '../helpers/run-cli.js';

describe('change graph command', () => {
  const testDir = path.join(process.cwd(), 'test-change-graph-tmp');
  const changesDir = path.join(testDir, 'openspec', 'changes');

  beforeEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
    await fs.mkdir(changesDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('displays active relationships in deterministic dependency order', async () => {
    await writeChange('gamma', ['alpha']);
    await writeChange('beta');
    await writeChange('delta', ['alpha']);
    await writeChange('alpha');

    const result = await runCLI(['change', 'graph'], { cwd: testDir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe([
      'Recommended dependency order:',
      '1. alpha',
      '2. beta',
      '3. delta (depends on: alpha)',
      '4. gamma (depends on: alpha)',
    ].join('\n'));
  });

  it('preserves advisory warnings while displaying a valid graph', async () => {
    await writeChange('alpha', [], ['shared-area'], ['missing-marker']);
    await writeChange('bravo', [], ['shared-area']);

    const result = await runCLI(['change', 'graph'], { cwd: testDir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Recommended dependency order:');
    expect(result.stderr).toContain(
      'Active changes "alpha", "bravo" all touch "shared-area".'
    );
    expect(result.stderr).toContain(
      'No active or archived change provides required marker "missing-marker" for change "alpha".'
    );
  });

  it('fails with validation errors before displaying a cyclic graph', async () => {
    await writeChange('alpha', ['bravo', 'missing-change']);
    await writeChange('bravo', ['alpha']);

    const result = await runCLI(['change', 'graph'], { cwd: testDir });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain('Recommended dependency order:');
    expect(result.stderr).toContain(
      'Dependency cycle detected: alpha -> bravo -> alpha.'
    );
    expect(result.stderr).toContain(
      'Missing dependency target "missing-change" referenced by change "alpha".'
    );
  });

  async function writeChange(
    id: string,
    dependsOn: readonly string[] = [],
    touches: readonly string[] = [],
    requires: readonly string[] = []
  ): Promise<void> {
    const changeDir = path.join(changesDir, id);
    await fs.mkdir(changeDir, { recursive: true });
    await fs.writeFile(path.join(changeDir, 'proposal.md'), `# ${id}\n`);
    await fs.writeFile(
      path.join(changeDir, '.openspec.yaml'),
      [
        'schema: spec-driven\n',
        dependsOn.length > 0
          ? `dependsOn:\n${dependsOn.map(value => `  - ${value}\n`).join('')}`
          : '',
        touches.length > 0
          ? `touches:\n${touches.map(value => `  - ${value}\n`).join('')}`
          : '',
        requires.length > 0
          ? `requires:\n${requires.map(value => `  - ${value}\n`).join('')}`
          : '',
      ].join('')
    );
  }
});
