import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { readChangeMetadata } from '../../utils/change-metadata.js';

export type ChangeDependencyGraph = ReadonlyMap<string, readonly string[]>;
export type DependencyCycle = readonly string[];

export interface BlockedDependencyPath {
  kind: 'missing' | 'cycle';
  path: readonly string[];
  cycle?: DependencyCycle;
}

export interface ChangeDependencyAnalysis {
  cycles: readonly DependencyCycle[];
  cyclicChangeIds: ReadonlySet<string>;
  cycleByChangeId: ReadonlyMap<string, DependencyCycle>;
  missingDependencies: ReadonlyMap<string, readonly string[]>;
  blockedPaths: ReadonlyMap<string, readonly BlockedDependencyPath[]>;
}

/**
 * Find one deterministic representative cycle for each cyclic component.
 * Missing dependency targets are intentionally ignored here; they are a
 * separate validation concern.
 */
export function findDependencyCycles(graph: ChangeDependencyGraph): DependencyCycle[] {
  return findCyclicComponents(graph).map(component => component.cycle);
}

export function analyzeChangeDependencies(
  graph: ChangeDependencyGraph,
  resolvedDependencyIds: ReadonlySet<string> = new Set()
): ChangeDependencyAnalysis {
  const normalizedGraph = normalizeGraph(graph);
  const cyclicComponents = findCyclicComponents(normalizedGraph);
  const cycles = cyclicComponents.map(component => component.cycle);
  const cyclicChangeIds = new Set(cyclicComponents.flatMap(component => component.members));
  const cycleByChangeId = new Map<string, DependencyCycle>();
  for (const component of cyclicComponents) {
    for (const member of component.members) cycleByChangeId.set(member, component.cycle);
  }

  const missingDependencies = new Map<string, readonly string[]>();
  for (const [changeId, dependencies] of normalizedGraph) {
    const missing = dependencies.filter(
      dependency => !normalizedGraph.has(dependency) && !resolvedDependencyIds.has(dependency)
    );
    if (missing.length > 0) missingDependencies.set(changeId, missing);
  }

  const blockedPaths = findAllBlockedPaths(
    normalizedGraph,
    resolvedDependencyIds,
    cycleByChangeId,
    cyclicChangeIds
  );

  return { cycles, cyclicChangeIds, cycleByChangeId, missingDependencies, blockedPaths };
}

interface CyclicComponent {
  members: readonly string[];
  cycle: DependencyCycle;
}

function findCyclicComponents(graph: ChangeDependencyGraph): CyclicComponent[] {
  const nodes = [...graph.keys()].sort((left, right) => left.localeCompare(right));
  const knownNodes = new Set(nodes);
  const neighbors = new Map(
    nodes.map(node => [
      node,
      [...new Set(graph.get(node) ?? [])]
        .filter(dependency => knownNodes.has(dependency))
        .sort((left, right) => left.localeCompare(right)),
    ])
  );

  let nextIndex = 0;
  const indexByNode = new Map<string, number>();
  const lowLinkByNode = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cyclicComponents: string[][] = [];

  const visit = (node: string): void => {
    const nodeIndex = nextIndex++;
    indexByNode.set(node, nodeIndex);
    lowLinkByNode.set(node, nodeIndex);
    stack.push(node);
    onStack.add(node);

    for (const dependency of neighbors.get(node) ?? []) {
      if (!indexByNode.has(dependency)) {
        visit(dependency);
        lowLinkByNode.set(
          node,
          Math.min(lowLinkByNode.get(node)!, lowLinkByNode.get(dependency)!)
        );
      } else if (onStack.has(dependency)) {
        lowLinkByNode.set(
          node,
          Math.min(lowLinkByNode.get(node)!, indexByNode.get(dependency)!)
        );
      }
    }

    if (lowLinkByNode.get(node) !== indexByNode.get(node)) return;

    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);

    component.sort((left, right) => left.localeCompare(right));
    if (
      component.length > 1 ||
      (component.length === 1 && (neighbors.get(component[0]) ?? []).includes(component[0]))
    ) {
      cyclicComponents.push(component);
    }
  };

  for (const node of nodes) {
    if (!indexByNode.has(node)) visit(node);
  }

  return cyclicComponents
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(component => ({
      members: component,
      cycle: representativeCycle(component, neighbors),
    }));
}

/** Analyze active changes and archived dependency history adjacent to `changeDir`. */
export async function analyzeActiveChangeDependencies(
  changeDir: string
): Promise<ChangeDependencyAnalysis> {
  const changesDir = path.dirname(changeDir);
  const projectRoot = path.resolve(changesDir, '..', '..');
  const entries = await fs.readdir(changesDir, { withFileTypes: true });
  const graph = new Map<string, readonly string[]>();

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'archive') continue;

    const activeChangeDir = path.join(changesDir, entry.name);
    try {
      await fs.access(path.join(activeChangeDir, 'proposal.md'));
    } catch {
      continue;
    }

    try {
      const metadata = readChangeMetadata(activeChangeDir, projectRoot);
      graph.set(entry.name, metadata?.dependsOn ?? []);
    } catch {
      // Metadata shape/schema errors are reported by metadata validation. They
      // cannot contribute a trustworthy dependency edge here.
      graph.set(entry.name, []);
    }
  }

  const archivedChangeIds = await readArchivedChangeIds(path.join(changesDir, 'archive'));
  return analyzeChangeDependencies(graph, archivedChangeIds);
}

export function formatDependencyCycle(cycle: DependencyCycle): string {
  return `Dependency cycle detected: ${cycle.join(' -> ')}. Remove one dependsOn entry to break the cycle.`;
}

export function formatMissingDependency(changeId: string, dependencyId: string): string {
  return `Missing dependency target "${dependencyId}" referenced by change "${changeId}". Add or restore the change, or remove it from dependsOn.`;
}

export function formatBlockedDependency(changeId: string, blocked: BlockedDependencyPath): string {
  if (blocked.kind === 'missing') {
    return `Change "${changeId}" is transitively blocked by unresolved dependency path: ${blocked.path.join(' -> ')}. Resolve the missing target before continuing.`;
  }
  return `Change "${changeId}" is transitively blocked by cyclic dependency path: ${blocked.path.join(' -> ')}. Break the dependency cycle: ${blocked.cycle!.join(' -> ')}.`;
}

function normalizeGraph(graph: ChangeDependencyGraph): Map<string, readonly string[]> {
  return new Map(
    [...graph.keys()]
      .sort((left, right) => left.localeCompare(right))
      .map(changeId => [
        changeId,
        [...new Set(graph.get(changeId) ?? [])]
          .sort((left, right) => left.localeCompare(right)),
      ])
  );
}

function findAllBlockedPaths(
  graph: ReadonlyMap<string, readonly string[]>,
  resolvedDependencyIds: ReadonlySet<string>,
  cycleByChangeId: ReadonlyMap<string, DependencyCycle>,
  cyclicChangeIds: ReadonlySet<string>
): Map<string, readonly BlockedDependencyPath[]> {
  const memo = new Map<string, readonly BlockedDependencyPath[]>();

  const collect = (changeId: string): readonly BlockedDependencyPath[] => {
    const cached = memo.get(changeId);
    if (cached) return cached;

    const resultByCause = new Map<string, BlockedDependencyPath>();
    const record = (cause: string, blocked: BlockedDependencyPath): void => {
      const existing = resultByCause.get(cause);
      if (!existing || comparePaths(blocked.path, existing.path) < 0) {
        resultByCause.set(cause, blocked);
      }
    };

    for (const dependency of graph.get(changeId) ?? []) {
      if (resolvedDependencyIds.has(dependency)) continue;

      if (!graph.has(dependency)) {
        record(`missing:${dependency}`, {
          kind: 'missing',
          path: [changeId, dependency],
        });
        continue;
      }

      const cycle = cycleByChangeId.get(dependency);
      if (cycle) {
        record(`cycle:${cycle.join('\0')}`, {
          kind: 'cycle',
          path: [changeId, dependency],
          cycle,
        });
        continue;
      }

      for (const blocked of collect(dependency)) {
        record(blockedCause(blocked), {
          ...blocked,
          path: [changeId, ...blocked.path],
        });
      }
    }

    const result = [...resultByCause.values()].sort(compareBlockedPaths);
    memo.set(changeId, result);
    return result;
  };

  const blockedPaths = new Map<string, readonly BlockedDependencyPath[]>();
  for (const changeId of graph.keys()) {
    if (cyclicChangeIds.has(changeId)) continue;
    const transitivePaths = collect(changeId).filter(
      blocked => blocked.kind === 'cycle' || blocked.path.length > 2
    );
    if (transitivePaths.length > 0) blockedPaths.set(changeId, transitivePaths);
  }
  return blockedPaths;
}

function blockedCause(blocked: BlockedDependencyPath): string {
  return blocked.kind === 'missing'
    ? `missing:${blocked.path[blocked.path.length - 1]}`
    : `cycle:${blocked.cycle!.join('\0')}`;
}

function compareBlockedPaths(left: BlockedDependencyPath, right: BlockedDependencyPath): number {
  const pathOrder = comparePaths(left.path, right.path);
  return pathOrder !== 0 ? pathOrder : left.kind.localeCompare(right.kind);
}

function comparePaths(left: readonly string[], right: readonly string[]): number {
  return left.join('\0').localeCompare(right.join('\0'));
}

async function readArchivedChangeIds(archiveDir: string): Promise<Set<string>> {
  const result = new Set<string>();
  let entries: Dirent[];
  try {
    entries = await fs.readdir(archiveDir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      await fs.access(path.join(archiveDir, entry.name, 'proposal.md'));
    } catch {
      continue;
    }
    result.add(entry.name);
    const datedId = entry.name.match(/^\d{4}-\d{2}-\d{2}-(.+)$/)?.[1];
    if (datedId) result.add(datedId);
  }

  return result;
}

function representativeCycle(
  component: readonly string[],
  neighbors: ReadonlyMap<string, readonly string[]>
): DependencyCycle {
  const start = component[0];
  if (component.length === 1) return [start, start];

  const members = new Set(component);
  const path = [start];
  const visited = new Set([start]);

  const search = (node: string): string[] | undefined => {
    for (const dependency of neighbors.get(node) ?? []) {
      if (!members.has(dependency)) continue;
      if (dependency === start) return [...path, start];
      if (visited.has(dependency)) continue;

      visited.add(dependency);
      path.push(dependency);
      const cycle = search(dependency);
      if (cycle) return cycle;
      path.pop();
      visited.delete(dependency);
    }
    return undefined;
  };

  // Every member of a strongly connected component belongs to a cycle.
  return search(start)!;
}
