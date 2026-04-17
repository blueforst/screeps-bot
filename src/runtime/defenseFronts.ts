const FRONT_CLUSTER_RANGE = 6;

export interface DefenseFront {
  id: string;
  hostiles: Creep[];
  hostileIds: string[];
  centroid: {
    x: number;
    y: number;
  };
  threatScore: number;
}

interface MutableCluster {
  hostiles: Creep[];
}

function getHostileThreat(hostile: Creep): number {
  return (
    hostile.getActiveBodyparts(ATTACK) * 4 +
    hostile.getActiveBodyparts(RANGED_ATTACK) * 4 +
    hostile.getActiveBodyparts(HEAL) * 5 +
    hostile.getActiveBodyparts(WORK) * 3 +
    hostile.getActiveBodyparts(MOVE)
  );
}

function getClusterCentroid(hostiles: Creep[]): { x: number; y: number } {
  const total = hostiles.reduce(
    (sum, hostile) => ({
      x: sum.x + hostile.pos.x,
      y: sum.y + hostile.pos.y,
    }),
    { x: 0, y: 0 },
  );

  return {
    x: Math.round(total.x / hostiles.length),
    y: Math.round(total.y / hostiles.length),
  };
}

function isNearCluster(hostile: Creep, cluster: MutableCluster): boolean {
  return cluster.hostiles.some((member) => member.pos.getRangeTo(hostile.pos) <= FRONT_CLUSTER_RANGE);
}

export function buildDefenseFronts(hostiles: Creep[]): DefenseFront[] {
  if (hostiles.length === 0) {
    return [];
  }

  const clusters: MutableCluster[] = [];
  for (const hostile of hostiles) {
    const cluster = clusters.find((candidate) => isNearCluster(hostile, candidate));
    if (cluster) {
      cluster.hostiles.push(hostile);
    } else {
      clusters.push({ hostiles: [hostile] });
    }
  }

  return clusters
    .map((cluster) => ({
      hostiles: cluster.hostiles,
      centroid: getClusterCentroid(cluster.hostiles),
      threatScore: cluster.hostiles.reduce((sum, hostile) => sum + getHostileThreat(hostile), 0),
    }))
    .sort((left, right) => right.threatScore - left.threatScore)
    .map((cluster, index) => ({
      id: `front:${index}`,
      hostiles: cluster.hostiles,
      hostileIds: cluster.hostiles.map((hostile) => hostile.id),
      centroid: cluster.centroid,
      threatScore: cluster.threatScore,
    }));
}
