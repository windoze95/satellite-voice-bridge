// Shapes from the Home Assistant WebSocket API (registry list/partial dicts,
// states, service-call results). Only the fields the bridge uses.

export interface AreaEntry {
  area_id: string;
  name: string;
  aliases?: string[];
  floor_id?: string | null;
}

export interface DeviceEntry {
  id: string;
  area_id: string | null;
  name: string | null;
  name_by_user?: string | null;
}

export interface EntityEntry {
  entity_id: string;
  area_id: string | null;
  device_id: string | null;
  name: string | null;
  original_name: string | null;
  platform?: string;
  disabled_by: string | null;
  hidden_by: string | null;
  entity_category: string | null;
  /** Not in the list partial — enriched via config/entity_registry/get_entries. */
  aliases?: string[];
}

export interface HAContext {
  id: string;
  parent_id: string | null;
  user_id: string | null;
}

export interface HAState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown> & { friendly_name?: string };
  context?: HAContext;
}

export interface StateChangedData {
  entity_id: string;
  old_state: HAState | null;
  new_state: HAState | null;
}

export interface CallServiceResult {
  context: HAContext;
  response?: unknown;
}

export type RegistryEventType = 'area_registry_updated' | 'device_registry_updated' | 'entity_registry_updated';
