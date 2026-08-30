import type {
  JsonValue,
  SystemSetting,
  SystemSettingOption,
} from '../models/DittoConfig.js';

const PARAMETER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_PARAMETERS = new Set([
  'USER_COLLECTION_SYNC_SCOPES',
  'DQL_STRICT_MODE',
]);

export interface SystemSettingStore {
  execute(query: string, args?: Record<string, unknown>): Promise<unknown>;
}

export function normalizeSystemSettings(entries: readonly SystemSetting[] | undefined): SystemSetting[] {
  return (entries ?? []).map(entry => ({
    ...entry,
    parameter: entry.parameter.trim().toUpperCase(),
  }));
}

export function systemSettingsEqual(
  left: readonly SystemSetting[],
  right: readonly SystemSetting[],
): boolean {
  return stableJson(left) === stableJson(right);
}

export function validateSystemSettings(entries: unknown): string | null {
  if (entries === undefined) { return null; }
  if (!Array.isArray(entries)) { return 'Startup system settings must be a list.'; }
  const seen = new Set<string>();
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return 'Every startup system setting must be an object.';
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.parameter !== 'string' || !entry.parameter.trim()) {
      return 'Parameter name is required for every startup setting.';
    }
    const parameter = entry.parameter.trim().toUpperCase();
    if (!PARAMETER_PATTERN.test(parameter)) {
      return `Parameter "${entry.parameter.trim()}" has an invalid name.`;
    }
    if (RESERVED_PARAMETERS.has(parameter)) {
      return `Parameter "${parameter}" is managed by a dedicated control.`;
    }
    if (seen.has(parameter)) {
      return `Parameter "${parameter}" is configured more than once.`;
    }
    seen.add(parameter);
    switch (entry.type) {
      case 'boolean':
        if (typeof entry.value !== 'boolean') { return `Parameter "${parameter}" must be a boolean.`; }
        break;
      case 'integer':
        if (typeof entry.value !== 'number' || !Number.isSafeInteger(entry.value)) {
          return `Parameter "${parameter}" must be an integer.`;
        }
        break;
      case 'string':
        if (typeof entry.value !== 'string') { return `Parameter "${parameter}" must be text.`; }
        break;
      case 'json':
        if (!isJsonValue(entry.value)) { return `Parameter "${parameter}" must contain valid JSON.`; }
        break;
      default:
        return `Parameter "${parameter}" has an unsupported value type.`;
    }
  }
  return null;
}

export async function applySystemSettings(store: SystemSettingStore, entries: unknown): Promise<void> {
  const error = validateSystemSettings(entries);
  if (error) { throw new Error(error); }
  for (const entry of normalizeSystemSettings(entries as SystemSetting[] | undefined)) {
    try {
      await store.execute(`ALTER SYSTEM SET ${entry.parameter} TO :value`, { value: entry.value });
    } catch {
      // SDK errors may echo the rejected bound value. Keep persisted values out
      // of extension logs while still identifying the setting that blocked startup.
      throw new Error(`Failed to apply startup setting "${entry.parameter}".`);
    }
  }
}

export function parseShowAllOptions(result: unknown): SystemSettingOption[] {
  const items = extractItems(result);
  const options: SystemSettingOption[] = [];
  for (const item of items) {
    const row = unwrapValue(item);
    if (!row || typeof row !== 'object' || Array.isArray(row)) { continue; }
    const record = row as Record<string, unknown>;
    const parameter = firstString(record, ['parameter', 'parameter_name', 'name', 'setting'])?.trim().toUpperCase();
    let value = firstPresent(record, ['value', 'current_value', 'current']);
    if (!parameter) {
      const entries = Object.entries(record);
      const first = entries.length === 1 ? entries[0] : undefined;
      if (first) {
        const [singleParameter, singleValue] = first;
        value = singleValue;
        const option = optionFromValue(singleParameter, value);
        if (option) { options.push(option); }
        continue;
      }
      // SDK 5.x SHOW ALL shape: one item whose value is a single wide object
      // mapping every parameter name to its current value (~388 entries),
      // not one row per parameter. Verified live against 5.1.0 — and no
      // parameter is named like a column header, so the wide path cannot
      // misroute (probed: no 'name'/'parameter'/'value' keys exist).
      if (entries.length > 1) {
        for (const [key, entryValue] of entries) {
          const option = optionFromValue(key, entryValue);
          if (option) { options.push(option); }
        }
      }
      continue;
    }
    const option = optionFromValue(parameter, value);
    if (option) { options.push(option); }
  }
  const unique = new Map<string, SystemSettingOption>();
  for (const option of options) {
    if (!RESERVED_PARAMETERS.has(option.parameter) && !unique.has(option.parameter)) {
      unique.set(option.parameter, option);
    }
  }
  return [...unique.values()]
    .sort((a, b) => a.parameter.localeCompare(b.parameter));
}

function optionFromValue(parameter: string, value: unknown): SystemSettingOption | null {
  const normalized = parameter.trim().toUpperCase();
  if (!PARAMETER_PATTERN.test(normalized) || value === null || value === undefined) { return null; }
  // DQL returns large integers as bigint (SHOW ALL has bigint-valued
  // parameters); coerce within the safe range like peer-info's asNumber.
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    if (!Number.isSafeInteger(asNumber)) { return null; }
    return { parameter: normalized, type: 'integer', value: asNumber };
  }
  if (typeof value === 'boolean') { return { parameter: normalized, type: 'boolean', value }; }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return { parameter: normalized, type: 'integer', value };
  }
  if (typeof value === 'string') { return { parameter: normalized, type: 'string', value }; }
  if (isJsonValue(value)) { return { parameter: normalized, type: 'json', value }; }
  return null;
}

function extractItems(result: unknown): unknown[] {
  if (!result || typeof result !== 'object') { return []; }
  const items = (result as { items?: unknown }).items;
  return Array.isArray(items) ? items : [];
}

function unwrapValue(item: unknown): unknown {
  if (!item || typeof item !== 'object') { return item; }
  const record = item as Record<string, unknown>;
  const isMaterializedResultItem = 'value' in record
    && !['parameter', 'parameter_name', 'name', 'setting'].some(key => key in record);
  return isMaterializedResultItem ? record.value : item;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) { if (typeof record[key] === 'string') { return record[key]; } }
  return undefined;
}

function firstPresent(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) { if (key in record) { return record[key]; } }
  return undefined;
}

function isJsonValue(value: unknown): value is JsonValue {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let visited = 0;
  let textUnits = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (++visited > 10_000 || current.depth > 64) { return false; }
    const candidate = current.value;
    if (candidate === null || typeof candidate === 'boolean') { continue; }
    if (typeof candidate === 'string') {
      textUnits += candidate.length;
      if (textUnits > 1_000_000) { return false; }
      continue;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) { return false; }
      continue;
    }
    if (typeof candidate !== 'object' || seen.has(candidate)) { return false; }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const entry of candidate) { pending.push({ value: entry, depth: current.depth + 1 }); }
      continue;
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) { return false; }
    for (const [key, entry] of Object.entries(candidate as Record<string, unknown>)) {
      textUnits += key.length;
      if (textUnits > 1_000_000) { return false; }
      pending.push({ value: entry, depth: current.depth + 1 });
    }
  }
  return true;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) { return `[${value.map(stableJson).join(',')}]`; }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
