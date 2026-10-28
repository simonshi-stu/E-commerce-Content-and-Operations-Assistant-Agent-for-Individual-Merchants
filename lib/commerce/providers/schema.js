'use strict';
/**
 * Minimal, fail-closed JSON-schema subset validator for provider tool contracts (T2.5 rev-01).
 * Supported keywords: type/properties/required/additionalProperties (default false)/enum/const/
 * minimum/maximum/minLength/maxLength/items/maxItems/pattern. ANY unknown keyword is rejected and
 * every keyword must be APPLICABLE to its declared type (e.g. `integer + maxLength` is refused, not
 * silently ignored). Credential-looking field names are rejected wherever they appear. Strict
 * base64 decoding helper included (charset/padding/non-empty).
 */
const { ValidationError } = require('../evidence.js');

const SCHEMA_KEYWORDS = Object.freeze([
  'type', 'properties', 'required', 'additionalProperties', 'enum', 'const',
  'minimum', 'maximum', 'minLength', 'maxLength', 'items', 'maxItems', 'pattern'
]);
const SCHEMA_TYPES = Object.freeze(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
const KEYWORD_APPLICABILITY = Object.freeze({
  minLength: ['string'],
  maxLength: ['string'],
  pattern: ['string'],
  minimum: ['integer', 'number'],
  maximum: ['integer', 'number'],
  items: ['array'],
  maxItems: ['array'],
  properties: ['object'],
  required: ['object'],
  additionalProperties: ['object']
});
const CREDENTIAL_FIELD_RE = /^(authorization|api[_-]?key|openai[_-]?api[_-]?key|secret|password|bearer|access[_-]?token|client[_-]?secret|private[_-]?key)$/i;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function fail(message) {
  throw new ValidationError(message);
}
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function matchesType(type, value) {
  if (type === 'object') return isPlainObject(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  return value === null;
}

/** Recursively reject credential-looking field names (credentials are never business fields). */
function assertNoCredentialFields(value, path = 'value') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialFields(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_FIELD_RE.test(key)) fail(`${path}.${key} looks like a credential field; credentials are never business fields`);
    assertNoCredentialFields(child, `${path}.${key}`);
  }
}

/** Strict base64: charset/padding/length and a non-empty decode; returns the decoded bytes. */
function decodeStrictBase64(value, name) {
  if (typeof value !== 'string' || value === '') fail(`${name} must be a non-empty base64 string`);
  if (!BASE64_RE.test(value)) fail(`${name} must be strict base64 (standard alphabet and padding only; no whitespace or url-safe variants)`);
  if (value.length % 4 !== 0) fail(`${name} must be padded base64 whose length is a multiple of 4`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0) fail(`${name} must decode to non-empty bytes`);
  return bytes;
}

/** Deep-freeze pure data (never functions) for immutable contract snapshots. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** Validate a schema definition itself (unknown keywords and inapplicable keywords fail closed). */
function validateSchema(schema, path = 'schema') {
  if (!isPlainObject(schema)) fail(`${path} must be a plain object`);
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.includes(key)) fail(`${path}.${key} is not a supported schema keyword (fail-closed; unknown keywords are rejected)`);
  }
  if (!SCHEMA_TYPES.includes(schema.type)) fail(`${path}.type must be one of ${SCHEMA_TYPES.join(', ')}`);
  for (const [keyword, types] of Object.entries(KEYWORD_APPLICABILITY)) {
    if (schema[keyword] !== undefined && !types.includes(schema.type)) {
      fail(`${path}.${keyword} is not applicable to type ${schema.type} (fail-closed; constraints are never silently ignored)`);
    }
  }
  if (schema.type === 'object') {
    if (!isPlainObject(schema.properties)) fail(`${path}.properties must be a plain object`);
    for (const [name, child] of Object.entries(schema.properties)) {
      validateSchema(child, `${path}.properties.${name}`);
    }
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== 'string')) {
        fail(`${path}.required must be an array of strings`);
      }
      for (const name of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, name)) fail(`${path}.required references unknown property ${name}`);
      }
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
      fail(`${path}.additionalProperties must be a boolean`);
    }
  }
  if (schema.type === 'array') {
    if (schema.items === undefined) fail(`${path}.items is required for array schemas`);
    validateSchema(schema.items, `${path}.items`);
    if (schema.maxItems !== undefined && (!Number.isSafeInteger(schema.maxItems) || schema.maxItems < 0)) fail(`${path}.maxItems must be a safe non-negative integer`);
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) fail(`${path}.enum must be a non-empty array`);
    if (schema.type === 'object' || schema.type === 'array') {
      fail(`${path}.enum with ${schema.type} values is a complex enum semantic that is not supported (rejected explicitly; never silently skipped)`);
    }
    for (const candidate of schema.enum) {
      if (!matchesType(schema.type, candidate)) fail(`${path}.enum values must match the declared type ${schema.type}`);
    }
  }
  if (schema.const !== undefined) {
    if (schema.type === 'object' || schema.type === 'array') {
      fail(`${path}.const with ${schema.type} values is a complex const semantic that is not supported (rejected explicitly; never silently skipped)`);
    }
    if (!matchesType(schema.type, schema.const)) fail(`${path}.const must match the declared type ${schema.type}`);
  }
  if (schema.minimum !== undefined && !Number.isFinite(schema.minimum)) fail(`${path}.minimum must be a finite number`);
  if (schema.maximum !== undefined && !Number.isFinite(schema.maximum)) fail(`${path}.maximum must be a finite number`);
  if (schema.minLength !== undefined && (!Number.isSafeInteger(schema.minLength) || schema.minLength < 0)) fail(`${path}.minLength must be a safe non-negative integer`);
  if (schema.maxLength !== undefined && (!Number.isSafeInteger(schema.maxLength) || schema.maxLength < 0)) fail(`${path}.maxLength must be a safe non-negative integer`);
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') fail(`${path}.pattern must be a string`);
    try {
      new RegExp(schema.pattern);
    } catch {
      fail(`${path}.pattern must be a valid regular expression`);
    }
  }
  return schema;
}

/** Validate a value against a schema (already validated). Extra fields fail unless explicitly allowed. */
function validateValue(schema, value, path = 'value') {
  if (!matchesType(schema.type, value)) fail(`${path} must be of type ${schema.type}`);
  if (schema.enum !== undefined && !schema.enum.some((candidate) => candidate === value)) fail(`${path} must be one of the enum values`);
  if (schema.const !== undefined && value !== schema.const) fail(`${path} must equal the const value`);
  if (schema.type === 'object') {
    const properties = schema.properties || {};
    for (const name of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) fail(`${path}.${name} is required`);
    }
    const allowExtra = schema.additionalProperties === true;
    for (const [name, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, name)) {
        validateValue(properties[name], child, `${path}.${name}`);
      } else if (!allowExtra) {
        fail(`${path}.${name} is an unknown extra field (additionalProperties is false)`);
      }
    }
  }
  if (schema.type === 'array') {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`${path} exceeds maxItems ${schema.maxItems}`);
    value.forEach((item, index) => validateValue(schema.items, item, `${path}[${index}]`));
  }
  if (schema.type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(`${path} is shorter than minLength ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(`${path} is longer than maxLength ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) fail(`${path} does not match the required pattern`);
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`${path} is below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`${path} is above maximum ${schema.maximum}`);
  }
  return value;
}

module.exports = {
  SCHEMA_KEYWORDS,
  SCHEMA_TYPES,
  KEYWORD_APPLICABILITY,
  CREDENTIAL_FIELD_RE,
  assertNoCredentialFields,
  decodeStrictBase64,
  deepFreeze,
  validateSchema,
  validateValue
};
