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

export interface ChangeOverlap {
  area: string;
  changeIds: readonly string[];
}

export interface ActiveChangeValidationAnalysis extends ChangeDependencyAnalysis {
  activeDependencies: ChangeDependencyGraph;
  overlaps: readonly ChangeOverlap[];
  overlapsByChangeId: ReadonlyMap<string, readonly ChangeOverlap[]>;
  unmatchedRequiresByChangeId: ReadonlyMap<string, readonly string[]>;
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

export function findChangeOverlaps(
  touchesByChangeId: ReadonlyMap<string, readonly string[]>
): ChangeOverlap[] {
  const changesByArea = new Map<string, Set<string>>();
  for (const changeId of [...touchesByChangeId.keys()].sort((left, right) => left.localeCompare(right))) {
    for (const area of new Set(touchesByChangeId.get(changeId) ?? [])) {
      const changeIds = changesByArea.get(area) ?? new Set<string>();
      changeIds.add(changeId);
      changesByArea.set(area, changeIds);
    }
  }

  return [...changesByArea.entries()]
    .filter(([, changeIds]) => changeIds.size > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([area, changeIds]) => ({
      area,
      changeIds: [...changeIds].sort((left, right) => left.localeCompare(right)),
    }));
}

export function findUnmatchedRequirements(
  requiresByChangeId: ReadonlyMap<string, readonly string[]>,
  providedMarkers: ReadonlySet<string>
): Map<string, readonly string[]> {
  const result = new Map<string, readonly string[]>();
  for (const changeId of [...requiresByChangeId.keys()].sort((left, right) => left.localeCompare(right))) {
    const unmatched = [...new Set(requiresByChangeId.get(changeId) ?? [])]
      .filter(marker => !providedMarkers.has(marker))
      .sort((left, right) => left.localeCompare(right));
    if (unmatched.length > 0) result.set(changeId, unmatched);
  }
  return result;
}

export function getDependencyOrder(graph: ChangeDependencyGraph): string[] {
  const nodes = [...graph.keys()].sort((left, right) => left.localeCompare(right));
  const knownNodes = new Set(nodes);
  const remainingDependencies = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    const dependencies = [...new Set(graph.get(node) ?? [])]
      .filter(dependency => knownNodes.has(dependency));
    remainingDependencies.set(node, dependencies.length);
    for (const dependency of dependencies) {
      const dependencyDependents = dependents.get(dependency) ?? [];
      dependencyDependents.push(node);
      dependents.set(dependency, dependencyDependents);
    }
  }

  let layer = nodes.filter(node => remainingDependencies.get(node) === 0);
  const order: string[] = [];
  while (layer.length > 0) {
    layer.sort((left, right) => left.localeCompare(right));
    order.push(...layer);
    const nextLayer = new Set<string>();
    for (const node of layer) {
      for (const dependent of dependents.get(node) ?? []) {
        const remaining = remainingDependencies.get(dependent)! - 1;
        remainingDependencies.set(dependent, remaining);
        if (remaining === 0) nextLayer.add(dependent);
      }
    }
    layer = [...nextLayer];
  }

  if (order.length !== nodes.length) {
    throw new Error('Cannot compute dependency order while the active change graph contains a cycle.');
  }
  return order;
}

export function getUnblockedChanges(graph: ChangeDependencyGraph): string[] {
  const activeChangeIds = new Set(graph.keys());
  return getDependencyOrder(graph).filter(changeId =>
    (graph.get(changeId) ?? []).every(dependency => !activeChangeIds.has(dependency))
  );
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

/** Analyze stack metadata and archived dependency history adjacent to `changeDir`. */
export async function analyzeActiveChangeDependencies(
  changeDir: string
): Promise<ActiveChangeValidationAnalysis> {
  const changesDir = path.dirname(changeDir);
  const projectRoot = path.resolve(changesDir, '..', '..');
  const entries = await fs.readdir(changesDir, { withFileTypes: true });
  const graph = new Map<string, readonly string[]>();
  const touchesByChangeId = new Map<string, readonly string[]>();
  const requiresByChangeId = new Map<string, readonly string[]>();
  const activeProviderMarkers = new Set<string>();

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
      touchesByChangeId.set(entry.name, metadata?.touches ?? []);
      requiresByChangeId.set(entry.name, metadata?.requires ?? []);
      for (const marker of metadata?.provides ?? []) activeProviderMarkers.add(marker);
    } catch {
      // Metadata shape/schema errors are reported by metadata validation. They
      // cannot contribute a trustworthy dependency edge here.
      graph.set(entry.name, []);
      touchesByChangeId.set(entry.name, []);
      requiresByChangeId.set(entry.name, []);
    }
  }

  const archivedHistory = await readArchivedChangeHistory(
    path.join(changesDir, 'archive'),
    projectRoot
  );
  const dependencyAnalysis = analyzeChangeDependencies(graph, archivedHistory.changeIds);
  const overlaps = findChangeOverlaps(touchesByChangeId);
  const overlapsByChangeId = new Map<string, ChangeOverlap[]>();
  for (const overlap of overlaps) {
    for (const changeId of overlap.changeIds) {
      const changeOverlaps = overlapsByChangeId.get(changeId) ?? [];
      changeOverlaps.push(overlap);
      overlapsByChangeId.set(changeId, changeOverlaps);
    }
  }
  const providedMarkers = new Set([...activeProviderMarkers, ...archivedHistory.providedMarkers]);
  const unmatchedRequiresByChangeId = findUnmatchedRequirements(
    requiresByChangeId,
    providedMarkers
  );
  return {
    ...dependencyAnalysis,
    activeDependencies: graph,
    overlaps,
    overlapsByChangeId,
    unmatchedRequiresByChangeId,
  };
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

export function formatChangeOverlap(overlap: ChangeOverlap): string {
  return `Active changes ${overlap.changeIds.map(changeId => `"${changeId}"`).join(', ')} all touch "${overlap.area}". Coordinate ownership to avoid overlapping work.`;
}

export function formatUnmatchedRequirement(changeId: string, marker: string): string {
  return `No active or archived change provides required marker "${marker}" for change "${changeId}". Add a provider or remove the marker from requires.`;
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

interface ArchivedChangeHistory {
  changeIds: Set<string>;
  providedMarkers: Set<string>;
}

async function readArchivedChangeHistory(
  archiveDir: string,
  projectRoot: string
): Promise<ArchivedChangeHistory> {
  const changeIds = new Set<string>();
  const providedMarkers = new Set<string>();
  let entries: Dirent[];
  try {
    entries = await fs.readdir(archiveDir, { withFileTypes: true });
  } catch {
    return { changeIds, providedMarkers };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      await fs.access(path.join(archiveDir, entry.name, 'proposal.md'));
    } catch {
      continue;
    }
    changeIds.add(entry.name);
    const datedId = entry.name.match(/^\d{4}-\d{2}-\d{2}-(.+)$/)?.[1];
    if (datedId) changeIds.add(datedId);
    try {
      const metadata = readChangeMetadata(path.join(archiveDir, entry.name), projectRoot);
      for (const marker of metadata?.provides ?? []) providedMarkers.add(marker);
    } catch {
      // Invalid archived metadata cannot provide a trustworthy marker.
    }
  }

  return { changeIds, providedMarkers };
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
