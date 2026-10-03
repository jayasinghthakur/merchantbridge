/**
 * Turns a tool's input JSON Schema (as produced by zod's toJSONSchema) into simple form fields and back.
 * Supports string, number, integer, boolean, enum and arrays of scalars (entered as comma lists). Anything else
 * is listed in `unsupported` and can still be sent through the raw JSON editor.
 */

export type ScalarKind = 'string' | 'number' | 'integer';
export type FieldKind = ScalarKind | 'boolean' | 'enum' | 'array';

export interface FormField {
  name: string;
  kind: FieldKind;
  required: boolean;
  description: string | null;
  enumValues: string[];
  itemKind: ScalarKind | null;
  minimum: number | null;
  maximum: number | null;
  defaultValue: unknown;
}

/** Every field is edited as a string: booleans use '', 'true', 'false'; arrays use comma lists. */
export type FormValues = Record<string, string>;

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Unwraps nullable unions (`anyOf: [X, {type:'null'}]`, `type: ['string','null']`). */
function resolve(schema: unknown): JsonObject | null {
  if (!isObject(schema)) return null;
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    const nonNull = union.filter((s) => !(isObject(s) && s.type === 'null'));
    if (nonNull.length !== 1) return null;
    const inner = resolve(nonNull[0]);
    if (!inner) return null;
    return { ...inner, description: schema.description ?? inner.description, default: schema.default ?? inner.default };
  }
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((t) => t !== 'null');
    if (types.length !== 1) return null;
    return { ...schema, type: types[0] };
  }
  return schema;
}

function scalarKind(s: JsonObject): ScalarKind | null {
  return s.type === 'string' || s.type === 'number' || s.type === 'integer' ? s.type : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function schemaToFields(schema: unknown): { fields: FormField[]; unsupported: string[] } {
  const fields: FormField[] = [];
  const unsupported: string[] = [];
  if (!isObject(schema) || !isObject(schema.properties)) return { fields, unsupported };
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);

  for (const [name, raw] of Object.entries(schema.properties)) {
    const s = resolve(raw);
    if (!s) {
      unsupported.push(name);
      continue;
    }
    const base = {
      name,
      required: required.has(name),
      description: typeof s.description === 'string' ? s.description : null,
      enumValues: [] as string[],
      itemKind: null as ScalarKind | null,
      minimum: num(s.minimum) ?? num(s.exclusiveMinimum),
      maximum: num(s.maximum) ?? num(s.exclusiveMaximum),
      defaultValue: s.default,
    };
    if (Array.isArray(s.enum) && s.enum.every((v) => typeof v === 'string')) {
      fields.push({ ...base, kind: 'enum', enumValues: s.enum });
    } else if (typeof s.const === 'string') {
      fields.push({ ...base, kind: 'enum', enumValues: [s.const] });
    } else if (s.type === 'boolean') {
      fields.push({ ...base, kind: 'boolean' });
    } else if (s.type === 'array') {
      const items = resolve(s.items);
      const itemKind = items ? scalarKind(items) : null;
      if (itemKind) fields.push({ ...base, kind: 'array', itemKind });
      else unsupported.push(name);
    } else {
      const kind = scalarKind(s);
      if (kind) fields.push({ ...base, kind });
      else unsupported.push(name);
    }
  }
  return { fields, unsupported };
}

function parseNumber(raw: string, kind: ScalarKind): number | string {
  if (kind === 'string') return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error('must be a number');
  if (kind === 'integer' && !Number.isInteger(n)) throw new Error('must be a whole number');
  return n;
}

/** Builds tool args from form values. Empty optional fields are omitted so server defaults apply. */
export function valuesToArgs(
  fields: readonly FormField[],
  values: FormValues,
): { args: Record<string, unknown>; errors: Record<string, string> } {
  const args: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const raw = (values[f.name] ?? '').trim();
    if (raw === '') {
      if (f.required) errors[f.name] = 'required';
      continue;
    }
    try {
      switch (f.kind) {
        case 'string':
        case 'enum':
          args[f.name] = raw;
          break;
        case 'number':
        case 'integer':
          args[f.name] = parseNumber(raw, f.kind);
          break;
        case 'boolean':
          args[f.name] = raw === 'true';
          break;
        case 'array':
          args[f.name] = raw
            .split(',')
            .map((p) => p.trim())
            .filter((p) => p !== '')
            .map((p) => parseNumber(p, f.itemKind ?? 'string'));
          break;
      }
    } catch (e) {
      errors[f.name] = e instanceof Error ? e.message : 'invalid';
    }
  }
  return { args, errors };
}

function scalarText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v) ?? '';
}

/** Form values pre-filled with each field's schema default. */
export function defaultValues(fields: readonly FormField[]): FormValues {
  return argsToValues(fields, Object.fromEntries(fields.map((f) => [f.name, f.defaultValue])));
}

/** Inverse of valuesToArgs, used when switching from the JSON editor back to the form. */
export function argsToValues(fields: readonly FormField[], args: Record<string, unknown>): FormValues {
  const values: FormValues = {};
  for (const f of fields) {
    const v = args[f.name];
    if (v === undefined || v === null) values[f.name] = '';
    else if (Array.isArray(v)) values[f.name] = v.map(scalarText).join(', ');
    else values[f.name] = scalarText(v);
  }
  return values;
}
