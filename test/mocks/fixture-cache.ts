// Build a RegistryCache directly from the synthetic-house fixture (no sockets).
import type { RegistryCache } from '../../src/ha/registry.js';
import type { AreaEntry, DeviceEntry, EntityEntry, HAState } from '../../src/ha/types.js';
import { loadFixtureRegistry } from './mock-ha-server.js';

export function buildFixtureCache(): RegistryCache {
  const data = loadFixtureRegistry();
  const entities = data.entities.map((e) => {
    const entry = { ...e } as unknown as EntityEntry;
    const aliases = data.full_entities[entry.entity_id]?.aliases;
    if (aliases) entry.aliases = aliases;
    return entry;
  });
  return {
    areasById: new Map((data.areas as unknown as AreaEntry[]).map((a) => [a.area_id, a])),
    devicesById: new Map((data.devices as unknown as DeviceEntry[]).map((d) => [d.id, d])),
    entitiesById: new Map(entities.map((e) => [e.entity_id, e])),
    statesById: new Map((data.states as unknown as HAState[]).map((s) => [s.entity_id, s])),
    builtAt: 0,
  };
}

export const TEST_POLICY = {
  dryRun: false,
  tiers: {
    green: ['light', 'fan', 'switch', 'media_player', 'scene', 'script'],
    yellow: ['lock', 'cover', 'climate'],
    red: ['alarm_control_panel'],
  },
  yellowAllow: [] as string[],
  matching: { minConfidence: 0.6, maxCollectiveTargets: 10 },
  areaAliases: {} as Record<string, string[]>,
};
