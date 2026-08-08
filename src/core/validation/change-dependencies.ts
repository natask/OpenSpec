import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readChangeMetadata } from '../../utils/change-metadata.js';

export type ChangeDependencyGraph = ReadonlyMap<string, readonly string[]>;
export type DependencyCycle = readonly string[];

/**
 * Find one deterministic representative cycle for each cyclic component.
 * Missing dependency targets are intentionally ignored here; they are a
 * separate validation concern.
 */
export function findDependencyCycles(graph: ChangeDependencyGraph): DependencyCycle[] {
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
    .map(component => representativeCycle(component, neighbors));
}

/** Load the dependency graph for active changes adjacent to `changeDir`. */
export async function findActiveChangeDependencyCycles(
  changeDir: string
): Promise<DependencyCycle[]> {
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

  return findDependencyCycles(graph);
}

export function formatDependencyCycle(cycle: DependencyCycle): string {
  return `Dependency cycle detected: ${cycle.join(' -> ')}. Remove one dependsOn entry to break the cycle.`;
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
