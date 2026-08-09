import { promises as fs } from 'fs';
import path from 'path';
import { JsonConverter } from '../core/converters/json-converter.js';
import { Validator } from '../core/validation/validator.js';
import { ChangeParser } from '../core/parsers/change-parser.js';
import { Change } from '../core/schemas/index.js';
import { isInteractive } from '../utils/interactive.js';
import { getActiveChangeIds } from '../utils/item-discovery.js';
import { createChange, validateChangeName } from '../utils/change-utils.js';
import { readChangeMetadata } from '../utils/change-metadata.js';
import {
  analyzeActiveChangeDependencies,
  formatBlockedDependency,
  formatChangeOverlap,
  formatDependencyCycle,
  formatMissingDependency,
  formatUnmatchedRequirement,
  getDependencyOrder,
  getUnblockedChanges,
  type ActiveChangeValidationAnalysis,
} from '../core/validation/change-dependencies.js';
import type { ValidationIssue } from '../core/validation/types.js';

interface SplitChild {
  id: string;
  title: string;
}

// Constants for better maintainability
const ARCHIVE_DIR = 'archive';
const TASK_PATTERN = /^[-*]\s+\[[\sx]\]/i;
const COMPLETED_TASK_PATTERN = /^[-*]\s+\[x\]/i;

export class ChangeCommand {
  private converter: JsonConverter;

  constructor() {
    this.converter = new JsonConverter();
  }

  /**
   * Show a change proposal.
   * - Text mode: raw markdown passthrough (no filters)
   * - JSON mode: minimal object with deltas; --deltas-only returns same object with filtered deltas
   *   Note: --requirements-only is deprecated alias for --deltas-only
   */
  async show(changeName?: string, options?: { json?: boolean; requirementsOnly?: boolean; deltasOnly?: boolean; noInteractive?: boolean }): Promise<void> {
    const changesPath = path.join(process.cwd(), 'openspec', 'changes');

    if (!changeName) {
      const canPrompt = isInteractive(options);
      const changes = await this.getActiveChanges(changesPath);
      if (canPrompt && changes.length > 0) {
        const { select } = await import('@inquirer/prompts');
        const selected = await select({
          message: 'Select a change to show',
          choices: changes.map(id => ({ name: id, value: id })),
        });
        changeName = selected;
      } else {
        if (changes.length === 0) {
          console.error('No change specified. No active changes found.');
        } else {
          console.error(`No change specified. Available IDs: ${changes.join(', ')}`);
        }
        console.error('Hint: use "openspec change list" to view available changes.');
        process.exitCode = 1;
        return;
      }
    }

    const proposalPath = path.join(changesPath, changeName, 'proposal.md');

    try {
      await fs.access(proposalPath);
    } catch {
      throw new Error(`Change "${changeName}" not found at ${proposalPath}`);
    }

    if (options?.json) {
      const jsonOutput = await this.converter.convertChangeToJson(proposalPath);

      if (options.requirementsOnly) {
        console.error('Flag --requirements-only is deprecated; use --deltas-only instead.');
      }

      const parsed: Change = JSON.parse(jsonOutput);
      const contentForTitle = await fs.readFile(proposalPath, 'utf-8');
      const title = this.extractTitle(contentForTitle, changeName);
      const id = parsed.name;
      const deltas = parsed.deltas || [];

      if (options.requirementsOnly || options.deltasOnly) {
        const output = { id, title, deltaCount: deltas.length, deltas };
        console.log(JSON.stringify(output, null, 2));
      } else {
        const output = {
          id,
          title,
          deltaCount: deltas.length,
          deltas,
        };
        console.log(JSON.stringify(output, null, 2));
      }
    } else {
      const content = await fs.readFile(proposalPath, 'utf-8');
      console.log(content);
    }
  }

  /**
   * List active changes.
   * - Text default: IDs only; --long prints minimal details (title, counts)
   * - JSON: array of { id, title, deltaCount, taskStatus }, sorted by id
   */
  async list(options?: { json?: boolean; long?: boolean }): Promise<void> {
    const changesPath = path.join(process.cwd(), 'openspec', 'changes');
    
    const changes = await this.getActiveChanges(changesPath);
    
    if (options?.json) {
      const changeDetails = await Promise.all(
        changes.map(async (changeName) => {
          const proposalPath = path.join(changesPath, changeName, 'proposal.md');
          const tasksPath = path.join(changesPath, changeName, 'tasks.md');
          
          try {
            const content = await fs.readFile(proposalPath, 'utf-8');
            const changeDir = path.join(changesPath, changeName);
            const parser = new ChangeParser(content, changeDir);
            const change = await parser.parseChangeWithDeltas(changeName);
            
            let taskStatus = { total: 0, completed: 0 };
            try {
              const tasksContent = await fs.readFile(tasksPath, 'utf-8');
              taskStatus = this.countTasks(tasksContent);
            } catch (error) {
              // Tasks file may not exist, which is okay
              if (process.env.DEBUG) {
                console.error(`Failed to read tasks file at ${tasksPath}:`, error);
              }
            }
            
            return {
              id: changeName,
              title: this.extractTitle(content, changeName),
              deltaCount: change.deltas.length,
              taskStatus,
            };
          } catch (error) {
            return {
              id: changeName,
              title: 'Unknown',
              deltaCount: 0,
              taskStatus: { total: 0, completed: 0 },
            };
          }
        })
      );
      
      const sorted = changeDetails.sort((a, b) => a.id.localeCompare(b.id));
      console.log(JSON.stringify(sorted, null, 2));
    } else {
      if (changes.length === 0) {
        console.log('No items found');
        return;
      }
      const sorted = [...changes].sort();
      if (!options?.long) {
        // IDs only
        sorted.forEach(id => console.log(id));
        return;
      }

      // Long format: id: title and minimal counts
      for (const changeName of sorted) {
        const proposalPath = path.join(changesPath, changeName, 'proposal.md');
        const tasksPath = path.join(changesPath, changeName, 'tasks.md');
        try {
          const content = await fs.readFile(proposalPath, 'utf-8');
          const title = this.extractTitle(content, changeName);
          let taskStatusText = '';
          try {
            const tasksContent = await fs.readFile(tasksPath, 'utf-8');
            const { total, completed } = this.countTasks(tasksContent);
            taskStatusText = ` [tasks ${completed}/${total}]`;
          } catch (error) {
            if (process.env.DEBUG) {
              console.error(`Failed to read tasks file at ${tasksPath}:`, error);
            }
          }
          const changeDir = path.join(changesPath, changeName);
          const parser = new ChangeParser(await fs.readFile(proposalPath, 'utf-8'), changeDir);
          const change = await parser.parseChangeWithDeltas(changeName);
          const deltaCountText = ` [deltas ${change.deltas.length}]`;
          console.log(`${changeName}: ${title}${deltaCountText}${taskStatusText}`);
        } catch {
          console.log(`${changeName}: (unable to read)`);
        }
      }
    }
  }

  async validate(changeName?: string, options?: { strict?: boolean; json?: boolean; noInteractive?: boolean }): Promise<void> {
    const changesPath = path.join(process.cwd(), 'openspec', 'changes');
    
    if (!changeName) {
      const canPrompt = isInteractive(options);
      const changes = await getActiveChangeIds();
      if (canPrompt && changes.length > 0) {
        const { select } = await import('@inquirer/prompts');
        const selected = await select({
          message: 'Select a change to validate',
          choices: changes.map(id => ({ name: id, value: id })),
        });
        changeName = selected;
      } else {
        if (changes.length === 0) {
          console.error('No change specified. No active changes found.');
        } else {
          console.error(`No change specified. Available IDs: ${changes.join(', ')}`);
        }
        console.error('Hint: use "openspec change list" to view available changes.');
        process.exitCode = 1;
        return;
      }
    }
    
    const changeDir = path.join(changesPath, changeName);
    
    try {
      await fs.access(changeDir);
    } catch {
      throw new Error(`Change "${changeName}" not found at ${changeDir}`);
    }
    
    const validator = new Validator(options?.strict || false);
    const report = await validator.validateChangeDeltaSpecs(changeDir);
    
    if (options?.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      if (report.valid) {
        console.log(`Change "${changeName}" is valid`);
      } else {
        console.error(`Change "${changeName}" has issues`);
        report.issues.forEach(issue => {
          const label = issue.level === 'ERROR' ? 'ERROR' : 'WARNING';
          const prefix = issue.level === 'ERROR' ? '✗' : '⚠';
          console.error(`${prefix} [${label}] ${issue.path}: ${issue.message}`);
        });
        // Next steps footer to guide fixing issues
        this.printNextSteps();
        if (!options?.json) {
          process.exitCode = 1;
        }
      }
    }
  }

  async graph(): Promise<void> {
    const changesPath = path.join(process.cwd(), 'openspec', 'changes');
    const analysis = await analyzeActiveChangeDependencies(path.join(changesPath, '.graph'));

    if (analysis.activeDependencies.size === 0) {
      console.log('No active changes found.');
      return;
    }

    if (!this.printGraphIssues(analysis)) return;

    const order = getDependencyOrder(analysis.activeDependencies);
    console.log('Recommended dependency order:');
    order.forEach((changeId, index) => {
      const dependencies = [...new Set(analysis.activeDependencies.get(changeId) ?? [])]
        .sort((left, right) => left.localeCompare(right));
      const relationship = dependencies.length > 0
        ? ` (depends on: ${dependencies.join(', ')})`
        : '';
      console.log(`${index + 1}. ${changeId}${relationship}`);
    });
  }

  async next(): Promise<void> {
    const changesPath = path.join(process.cwd(), 'openspec', 'changes');
    const analysis = await analyzeActiveChangeDependencies(path.join(changesPath, '.next'));

    if (analysis.activeDependencies.size === 0) {
      console.log('No active changes found.');
      return;
    }

    if (!this.printGraphIssues(analysis)) return;

    const unblockedChanges = getUnblockedChanges(analysis.activeDependencies);
    console.log('Recommended next changes:');
    unblockedChanges.forEach((changeId, index) => {
      console.log(`${index + 1}. ${changeId}`);
    });
  }

  async split(changeName: string): Promise<void> {
    const nameValidation = validateChangeName(changeName);
    if (!nameValidation.valid) {
      throw new Error(nameValidation.error);
    }

    const projectRoot = process.cwd();
    const changesPath = path.join(projectRoot, 'openspec', 'changes');
    const sourceDir = path.join(changesPath, changeName);
    const proposalPath = path.join(sourceDir, 'proposal.md');
    const tasksPath = path.join(sourceDir, 'tasks.md');

    try {
      await fs.access(proposalPath);
    } catch {
      throw new Error(`Change "${changeName}" not found at ${sourceDir}`);
    }

    let tasksContent: string;
    try {
      tasksContent = await fs.readFile(tasksPath, 'utf-8');
    } catch {
      throw new Error(
        `Change "${changeName}" cannot be split because ${tasksPath} is missing or unreadable.`
      );
    }

    const children = this.getSplitChildren(changeName, tasksContent);
    if (children.length === 0) {
      throw new Error(
        `Change "${changeName}" has no level-two task sections to scaffold as child slices.`
      );
    }

    const childIds = children.map(child => child.id);
    const duplicateId = childIds.find((childId, index) => childIds.indexOf(childId) !== index);
    if (duplicateId) {
      throw new Error(
        `Change "${changeName}" has task sections that produce duplicate child ID "${duplicateId}".`
      );
    }

    for (const childId of childIds) {
      try {
        await fs.access(path.join(changesPath, childId));
        throw new Error(
          `Cannot split change "${changeName}": child change "${childId}" already exists.`
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    const sourceMetadata = readChangeMetadata(sourceDir, projectRoot);
    for (const [index, child] of children.entries()) {
      const predecessorId = index === 0 ? changeName : children[index - 1].id;
      await createChange(projectRoot, child.id, {
        schema: sourceMetadata?.schema,
        metadata: {
          parent: changeName,
          dependsOn: [predecessorId],
        },
      });
      await fs.writeFile(
        path.join(changesPath, child.id, 'proposal.md'),
        this.getSplitProposalStub(changeName, child.title),
        'utf-8'
      );
      await fs.writeFile(
        path.join(changesPath, child.id, 'tasks.md'),
        this.getSplitTasksStub(child.title),
        'utf-8'
      );
    }

    console.log(`Scaffolded ${childIds.length} child changes from "${changeName}":`);
    childIds.forEach(childId => console.log(`- ${childId}`));
  }

  private async getActiveChanges(changesPath: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(changesPath, { withFileTypes: true });
      const result: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === ARCHIVE_DIR) continue;
        const proposalPath = path.join(changesPath, entry.name, 'proposal.md');
        try {
          await fs.access(proposalPath);
          result.push(entry.name);
        } catch {
          // skip directories without proposal.md
        }
      }
      return result.sort();
    } catch {
      return [];
    }
  }

  private extractTitle(content: string, changeName: string): string {
    const match = content.match(/^#\s+(?:Change:\s+)?(.+)$/im);
    return match ? match[1].trim() : changeName;
  }

  private countTasks(content: string): { total: number; completed: number } {
    const lines = content.split('\n');
    let total = 0;
    let completed = 0;
    
    for (const line of lines) {
      if (line.match(TASK_PATTERN)) {
        total++;
        if (line.match(COMPLETED_TASK_PATTERN)) {
          completed++;
        }
      }
    }
    
    return { total, completed };
  }

  private getSplitChildren(changeName: string, tasksContent: string): SplitChild[] {
    return [...tasksContent.matchAll(/^##\s+(?:\d+(?:\.\d+)*[.)]?\s+)?(.+?)\s*$/gm)]
      .map(([, title]) => ({
        title: title.trim(),
        slug: title
          .normalize('NFKD')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, ''),
      }))
      .filter(child => child.slug.length > 0)
      .map(child => ({ id: `${changeName}-${child.slug}`, title: child.title }));
  }

  private getSplitProposalStub(parentId: string, title: string): string {
    return [
      `# Change: ${title}`,
      '',
      '## Why',
      '',
      `<!-- Explain why this child slice of \`${parentId}\` should be implemented. -->`,
      '',
      '## What Changes',
      '',
      '<!-- Describe the bounded behavior delivered by this child slice. -->',
      '',
      '## Capabilities',
      '',
      '<!-- List new or modified capabilities and add their delta specs. -->',
      '',
      '## Impact',
      '',
      '<!-- List affected code, APIs, dependencies, and systems. -->',
      '',
    ].join('\n');
  }

  private getSplitTasksStub(title: string): string {
    return [
      `## 1. ${title}`,
      '',
      '- [ ] 1.1 Replace this scaffold with the implementation tasks for this slice',
      '',
    ].join('\n');
  }

  private getGraphIssues(analysis: ActiveChangeValidationAnalysis): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const cycle of analysis.cycles) {
      issues.push({ level: 'ERROR', path: 'dependsOn', message: formatDependencyCycle(cycle) });
    }
    for (const [changeId, dependencies] of analysis.missingDependencies) {
      for (const dependencyId of dependencies) {
        issues.push({
          level: 'ERROR',
          path: 'dependsOn',
          message: formatMissingDependency(changeId, dependencyId),
        });
      }
    }
    for (const [changeId, blockedPaths] of analysis.blockedPaths) {
      for (const blocked of blockedPaths) {
        issues.push({
          level: 'ERROR',
          path: 'dependsOn',
          message: formatBlockedDependency(changeId, blocked),
        });
      }
    }
    for (const overlap of analysis.overlaps) {
      issues.push({ level: 'WARNING', path: 'touches', message: formatChangeOverlap(overlap) });
    }
    for (const [changeId, markers] of analysis.unmatchedRequiresByChangeId) {
      for (const marker of markers) {
        issues.push({
          level: 'WARNING',
          path: 'requires',
          message: formatUnmatchedRequirement(changeId, marker),
        });
      }
    }
    return issues;
  }

  private printGraphIssues(analysis: ActiveChangeValidationAnalysis): boolean {
    const issues = this.getGraphIssues(analysis);
    for (const issue of issues) {
      const prefix = issue.level === 'ERROR' ? '✗' : '⚠';
      console.error(`${prefix} [${issue.level}] ${issue.path}: ${issue.message}`);
    }
    if (issues.some(issue => issue.level === 'ERROR')) {
      process.exitCode = 1;
      return false;
    }
    return true;
  }

  private printNextSteps(): void {
    const bullets: string[] = [];
    bullets.push('- Ensure change has deltas in specs/: use headers ## ADDED/MODIFIED/REMOVED/RENAMED Requirements');
    bullets.push('- Each requirement MUST include at least one #### Scenario: block');
    bullets.push('- Debug parsed deltas: openspec change show <id> --json --deltas-only');
    console.error('Next steps:');
    bullets.forEach(b => console.error(`  ${b}`));
  }
}
