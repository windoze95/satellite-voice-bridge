// Area/device/entity/state cache: synced on every (re)connect, alias-enriched
// for voice domains, refreshed (debounced) on registry-change events.
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../logger.js';
import type { HAClient } from './client.js';
import type { AreaEntry, DeviceEntry, EntityEntry, HAState, StateChangedData } from './types.js';

export interface RegistryCache {
  areasById: Map<string, AreaEntry>;
  devicesById: Map<string, DeviceEntry>;
  entitiesById: Map<string, EntityEntry>;
  statesById: Map<string, HAState>;
  builtAt: number;
}

const GET_ENTRIES_CHUNK = 500;

/** Events: 'updated'(RegistryCache) */
export class Registry extends EventEmitter {
  cache: RegistryCache | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly opts: {
      /** Domains whose entities get alias enrichment (the controllable ones). */
      voiceDomains: string[];
      /** Optional debug dump, e.g. var/registry-cache.json (gitignored). */
      cacheDumpPath?: string;
      refreshDebounceMs?: number;
    },
  ) {
    super();
  }

  /** Full fetch; used as the client's onSync hook and for debounced refreshes. */
  async sync(client: HAClient): Promise<void> {
    const [areas, devices, entities, states] = await Promise.all([
      client.request<AreaEntry[]>({ type: 'config/area_registry/list' }),
      client.request<DeviceEntry[]>({ type: 'config/device_registry/list' }),
      client.request<EntityEntry[]>({ type: 'config/entity_registry/list' }),
      client.request<HAState[]>({ type: 'get_states' }),
    ]);

    const entitiesById = new Map(entities.map((e) => [e.entity_id, e]));
    await this.enrichAliases(client, entitiesById);

    this.cache = {
      areasById: new Map(areas.map((a) => [a.area_id, a])),
      devicesById: new Map(devices.map((d) => [d.id, d])),
      entitiesById,
      statesById: new Map(states.map((s) => [s.entity_id, s])),
      builtAt: Date.now(),
    };
    this.logger.info('registry: synced', {
      areas: areas.length,
      devices: devices.length,
      entities: entities.length,
    });
    this.dump();
    this.emit('updated', this.cache);
  }

  /** Wire live updates from a client (call once per client instance). */
  attach(client: HAClient): void {
    client.on('registry_changed', () => this.scheduleRefresh(client));
    client.on('state_changed', (data: StateChangedData) => this.applyStateChanged(data));
  }

  private scheduleRefresh(client: HAClient): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.sync(client).catch((err) => {
        this.logger.warn('registry: refresh failed (will retry on next change/reconnect)', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.opts.refreshDebounceMs ?? 500);
    this.refreshTimer.unref?.();
  }

  private applyStateChanged(data: StateChangedData): void {
    if (!this.cache) return;
    if (data.new_state) this.cache.statesById.set(data.entity_id, data.new_state);
    else this.cache.statesById.delete(data.entity_id);
  }

  /** The list partial has no aliases; fetch full entries for voice domains. */
  private async enrichAliases(client: HAClient, entitiesById: Map<string, EntityEntry>): Promise<void> {
    const wanted = [...entitiesById.keys()].filter((id) => {
      const domain = id.split('.', 1)[0] ?? '';
      return this.opts.voiceDomains.includes(domain);
    });
    for (let i = 0; i < wanted.length; i += GET_ENTRIES_CHUNK) {
      const chunk = wanted.slice(i, i + GET_ENTRIES_CHUNK);
      try {
        const full = await client.request<Record<string, (EntityEntry & { aliases?: string[] }) | null>>({
          type: 'config/entity_registry/get_entries',
          entity_ids: chunk,
        });
        for (const [entityId, entry] of Object.entries(full)) {
          const existing = entitiesById.get(entityId);
          if (existing && entry?.aliases) existing.aliases = entry.aliases;
        }
      } catch (err) {
        this.logger.warn('registry: alias enrichment failed; matching falls back to names only', {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }
  }

  private dump(): void {
    const path = this.opts.cacheDumpPath;
    if (!path || !this.cache) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify(
          {
            builtAt: new Date(this.cache.builtAt).toISOString(),
            areas: [...this.cache.areasById.values()],
            devices: [...this.cache.devicesById.values()],
            entities: [...this.cache.entitiesById.values()],
            states: [...this.cache.statesById.values()],
          },
          null,
          2,
        ),
      );
    } catch {
      // Debug dump only.
    }
  }
}

/** Display name for an entity: state friendly_name, registry names, else id tail. */
export function displayName(cache: RegistryCache, entityId: string): string {
  const friendly = cache.statesById.get(entityId)?.attributes.friendly_name;
  if (friendly) return friendly;
  const entry = cache.entitiesById.get(entityId);
  return entry?.name ?? entry?.original_name ?? entityId.split('.').slice(1).join('.').replaceAll('_', ' ');
}

/** Effective area: the entity's own, else its device's. */
export function effectiveAreaId(cache: RegistryCache, entityId: string): string | null {
  const entry = cache.entitiesById.get(entityId);
  if (!entry) return null;
  if (entry.area_id) return entry.area_id;
  if (entry.device_id) return cache.devicesById.get(entry.device_id)?.area_id ?? null;
  return null;
}
