import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeCommand } from '../../src/commands/change.js';
import { createChange } from '../../src/utils/change-utils.js';
import { readChangeMetadata } from '../../src/utils/change-metadata.js';

describe('change split', () => {
  const originalCwd = process.cwd();
  let testDir: string;
  let sourceDir: string;
  let originalProposal: string;
  let originalTasks: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `openspec-change-split-${randomUUID()}`);
    await fs.mkdir(testDir, { recursive: true });
    await createChange(testDir, 'large-change');
    sourceDir = path.join(testDir, 'openspec', 'changes', 'large-change');
    originalProposal = '# Change: Large Change\n\nKeep this planning proposal intact.\n';
    originalTasks = [
      '# Tasks',
      '',
      'Preserve this planning preamble.',
      '',
      '## 1. Storage Layer',
      '',
      '- [ ] 1.1 Add storage',
      '- [ ] 1.2 Test storage',
      '',
      '## 2. HTTP API',
      '',
      '- [ ] 2.1 Add API',
      '',
    ].join('\n');
    await fs.writeFile(path.join(sourceDir, 'proposal.md'), originalProposal, 'utf-8');
    await fs.writeFile(path.join(sourceDir, 'tasks.md'), originalTasks, 'utf-8');
    process.chdir(testDir);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('moves implementation sections into ordered child scaffolds and converts the source to a plan', async () => {
    const sourceMetadataBefore = await fs.readFile(
      path.join(sourceDir, '.openspec.yaml'),
      'utf-8'
    );
    await new ChangeCommand().split('large-change');

    const changesDir = path.join(testDir, 'openspec', 'changes');
    const storageDir = path.join(changesDir, 'large-change-storage-layer');
    const apiDir = path.join(changesDir, 'large-change-http-api');

    expect((await fs.readdir(storageDir)).sort()).toEqual([
      '.openspec.yaml',
      'proposal.md',
      'tasks.md',
    ]);
    expect((await fs.readdir(apiDir)).sort()).toEqual([
      '.openspec.yaml',
      'proposal.md',
      'tasks.md',
    ]);
    expect(readChangeMetadata(storageDir, testDir)).toMatchObject({
      schema: 'spec-driven',
      parent: 'large-change',
      dependsOn: ['large-change'],
    });
    expect(readChangeMetadata(apiDir, testDir)).toMatchObject({
      schema: 'spec-driven',
      parent: 'large-change',
      dependsOn: ['large-change-storage-layer'],
    });

    expect(await fs.readFile(path.join(storageDir, 'tasks.md'), 'utf-8')).toBe([
      '## 1. Storage Layer',
      '',
      '- [ ] 1.1 Add storage',
      '- [ ] 1.2 Test storage',
      '',
    ].join('\n'));
    expect(await fs.readFile(path.join(apiDir, 'tasks.md'), 'utf-8')).toBe([
      '## 2. HTTP API',
      '',
      '- [ ] 2.1 Add API',
      '',
    ].join('\n'));
    expect(await fs.readFile(path.join(storageDir, 'proposal.md'), 'utf-8'))
      .toContain('child slice of `large-change`');
    expect(await fs.readFile(path.join(apiDir, 'proposal.md'), 'utf-8'))
      .toContain('# Change: HTTP API');

    const parentTasks = await fs.readFile(path.join(sourceDir, 'tasks.md'), 'utf-8');
    expect(parentTasks).toBe([
      '# Tasks',
      '',
      'Preserve this planning preamble.',
      '',
      '<!-- This source change is a planning container. Implementation tasks live in its child changes. -->',
      '',
      '## 1. Storage Layer',
      '',
      '- [ ] 1.1 Track completion of child change `large-change-storage-layer`',
      '',
      '## 2. HTTP API',
      '',
      '- [ ] 2.1 Track completion of child change `large-change-http-api`',
      '',
    ].join('\n'));
    expect(parentTasks).not.toContain('Add storage');
    expect(parentTasks).not.toContain('Test storage');
    expect(parentTasks).not.toContain('Add API');
    expect(await fs.readFile(path.join(sourceDir, 'proposal.md'), 'utf-8'))
      .toBe(originalProposal);
    expect(await fs.readFile(path.join(sourceDir, '.openspec.yaml'), 'utf-8'))
      .toBe(sourceMetadataBefore);
  });

  it('fails deterministically on re-split without mutating source or child content', async () => {
    const command = new ChangeCommand();
    await command.split('large-change');
    const changesDir = path.join(testDir, 'openspec', 'changes');
    const childProposal = path.join(
      changesDir,
      'large-change-storage-layer',
      'proposal.md'
    );
    await fs.writeFile(childProposal, 'user-authored child proposal\n', 'utf-8');
    const sourceTasksBefore = await fs.readFile(path.join(sourceDir, 'tasks.md'), 'utf-8');

    const firstError = await captureError(() => command.split('large-change'));
    const secondError = await captureError(() => command.split('large-change'));

    expect(firstError).toBe(
      'Cannot split change "large-change": child change "large-change-storage-layer" already exists.'
    );
    expect(secondError).toBe(firstError);
    expect(await fs.readFile(childProposal, 'utf-8')).toBe('user-authored child proposal\n');
    expect(await fs.readFile(path.join(sourceDir, 'tasks.md'), 'utf-8'))
      .toBe(sourceTasksBefore);
  });

  it('rolls back generated children and preserves source tasks when parent replacement fails', async () => {
    const sourceTasksPath = path.join(sourceDir, 'tasks.md');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('forced atomic replacement failure'), { code: 'EIO' })
    );

    await expect(new ChangeCommand().split('large-change'))
      .rejects.toThrow('forced atomic replacement failure');

    const changesDir = path.join(testDir, 'openspec', 'changes');
    await expect(fs.access(path.join(changesDir, 'large-change-storage-layer')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(changesDir, 'large-change-http-api')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(sourceTasksPath, 'utf-8')).toBe(originalTasks);
    expect((await fs.readdir(sourceDir)).some(name => name.includes('.split-'))).toBe(false);
  });
});

async function captureError(operation: () => Promise<void>): Promise<string> {
  try {
    await operation();
    throw new Error('Expected operation to fail');
  } catch (error) {
    return (error as Error).message;
  }
}
