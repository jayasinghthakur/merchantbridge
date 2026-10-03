import { describe, expect, it } from 'vitest';
import { argsToValues, defaultValues, schemaToFields, valuesToArgs } from '../lib/schema-form';

const schema = {
  type: 'object',
  properties: {
    sku: { type: 'string', description: 'Exact SKU' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    status: { type: 'string', enum: ['paid', 'unpaid', 'overdue'] },
    include_inactive: { type: 'boolean' },
    item_ids: { type: 'array', items: { type: 'string' } },
    note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    nested: { type: 'object', properties: {} },
  },
  required: ['sku'],
  additionalProperties: false,
};

describe('schemaToFields', () => {
  it('maps supported kinds and reports the rest', () => {
    const { fields, unsupported } = schemaToFields(schema);
    expect(fields.map((f) => [f.name, f.kind])).toEqual([
      ['sku', 'string'],
      ['limit', 'integer'],
      ['status', 'enum'],
      ['include_inactive', 'boolean'],
      ['item_ids', 'array'],
      ['note', 'string'],
    ]);
    expect(unsupported).toEqual(['nested']);
    expect(fields[0]?.required).toBe(true);
  });
});

describe('valuesToArgs', () => {
  const { fields } = schemaToFields(schema);

  it('coerces types and omits empty optionals', () => {
    const { args, errors } = valuesToArgs(fields, {
      sku: 'CHAI-250',
      limit: '5',
      include_inactive: 'false',
      item_ids: 'a, b,,c',
      status: '',
    });
    expect(errors).toEqual({});
    expect(args).toEqual({
      sku: 'CHAI-250',
      limit: 5,
      include_inactive: false,
      item_ids: ['a', 'b', 'c'],
    });
  });

  it('reports missing required fields and bad numbers', () => {
    const { errors } = valuesToArgs(fields, { sku: '', limit: '2.5' });
    expect(errors).toEqual({ sku: 'required', limit: 'must be a whole number' });
  });

  it('round-trips through argsToValues and fills defaults', () => {
    const values = argsToValues(fields, { sku: 'X', item_ids: ['1', '2'], include_inactive: true });
    expect(valuesToArgs(fields, values).args).toEqual({
      sku: 'X',
      item_ids: ['1', '2'],
      include_inactive: true,
    });
    expect(defaultValues(fields).limit).toBe('20');
  });
});
