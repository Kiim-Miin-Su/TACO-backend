import { isDeepStrictEqual } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import type { OpenAPIObject } from '@nestjs/swagger';
import {
  OPENAPI_DESCRIPTION,
  OPENAPI_TITLE,
  OPENAPI_VERSION,
  PUBLIC_OPENAPI_OPERATION_KEYS,
} from '../src/config/openapi';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const POSITIVE_INTEGER_QUERY_NAMES = new Set([
  'actorId',
  'counselFormId',
  'entityId',
  'expectedSeriesVersion',
  'instructorId',
  'ownerId',
  'roomId',
  'sessionId',
  'studentId',
]);
const BOUNDED_INTEGER_QUERIES = new Map<string, { minimum: number; maximum: number }>([
  ['limit', { minimum: 1, maximum: 500 }],
  ['months', { minimum: 1, maximum: 12 }],
]);

function fail(messages: string[]): never {
  throw new Error(`OpenAPI artifact verification failed:\n- ${messages.join('\n- ')}`);
}

function resolveLocalRef(document: unknown, ref: string): boolean {
  if (!ref.startsWith('#/')) return false;
  let current: unknown = document;
  for (const part of ref.slice(2).split('/').map((value) => value.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!current || typeof current !== 'object' || !(part in current)) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return true;
}

function collectRefs(value: unknown, refs: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => collectRefs(item, refs));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') refs.push(item);
      else collectRefs(item, refs);
    }
  }
  return refs;
}

function main(): void {
  const jsonPath = join(process.cwd(), 'openapi.json');
  const yamlPath = join(process.cwd(), 'docs/api/openapi.yaml');
  const json = JSON.parse(readFileSync(jsonPath, 'utf8')) as OpenAPIObject;
  const yaml = load(readFileSync(yamlPath, 'utf8')) as OpenAPIObject;
  const errors: string[] = [];

  if (!isDeepStrictEqual(json, yaml)) errors.push('openapi.json and docs/api/openapi.yaml are not semantically identical');
  if (json.openapi !== '3.0.0') errors.push(`unexpected OpenAPI version: ${json.openapi}`);
  if (json.info?.title !== OPENAPI_TITLE) errors.push(`unexpected title: ${json.info?.title}`);
  if (json.info?.version !== OPENAPI_VERSION) errors.push(`unexpected API version: ${json.info?.version}`);
  if (json.info?.description !== OPENAPI_DESCRIPTION) errors.push('description does not match the production API contract');
  if (!json.servers?.some((server) => server.url === '/')) errors.push('current-host server URL is missing');
  if (!json.components?.securitySchemes?.bearer) errors.push('bearer security scheme is missing');
  if (!json.components?.securitySchemes?.access_token) errors.push('access_token cookie security scheme is missing');
  if (!json.security?.length) errors.push('default protected security requirement is missing');

  const operationIds = new Set<string>();
  const seenPublic = new Set<string>();
  let operations = 0;
  let summaries = 0;
  for (const [path, pathItem] of Object.entries(json.paths ?? {})) {
    for (const [method, rawOperation] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method) || !rawOperation || typeof rawOperation !== 'object') continue;
      operations += 1;
      const operation = rawOperation as {
        operationId?: string;
        summary?: string;
        tags?: string[];
        responses?: Record<string, unknown>;
        security?: Array<Record<string, string[]>>;
        parameters?: Array<{
          in?: string;
          name?: string;
          schema?: {
            type?: string;
            format?: string;
            minimum?: number;
            maximum?: number;
          };
        }>;
      };
      const key = `${method.toUpperCase()} ${path}`;
      if (!operation.operationId) errors.push(`${key} has no operationId`);
      else if (operationIds.has(operation.operationId)) errors.push(`${key} duplicates operationId ${operation.operationId}`);
      else operationIds.add(operation.operationId);
      if (operation.summary) summaries += 1;
      else errors.push(`${key} has no summary`);
      if (!operation.tags?.length) errors.push(`${key} has no tag`);
      if (!operation.responses || !Object.keys(operation.responses).length) errors.push(`${key} has no response`);
      if (!Array.isArray(operation.security)) errors.push(`${key} has no explicit security boundary`);
      for (const parameter of operation.parameters ?? []) {
        const bounded =
          parameter.in === 'query' && parameter.name
            ? BOUNDED_INTEGER_QUERIES.get(parameter.name)
            : undefined;
        const isPositiveInteger =
          parameter.in === 'path' ||
          (parameter.in === 'query' &&
            parameter.name != null &&
            POSITIVE_INTEGER_QUERY_NAMES.has(parameter.name));
        if (!bounded && !isPositiveInteger) continue;
        const expectedMinimum = bounded?.minimum ?? 1;
        const expectedMaximum = bounded?.maximum ?? POSTGRES_INTEGER_MAX;
        if (
          parameter.schema?.type !== 'integer' ||
          parameter.schema?.format !== 'int32' ||
          parameter.schema?.minimum !== expectedMinimum ||
          parameter.schema?.maximum !== expectedMaximum
        ) {
          errors.push(
            `${key} ${parameter.in} ${parameter.name ?? '?'} must be int32 ${expectedMinimum}..${expectedMaximum}`,
          );
        }
      }

      if (PUBLIC_OPENAPI_OPERATION_KEYS.has(key)) {
        seenPublic.add(key);
        if (operation.security?.length) errors.push(`${key} must be explicitly public with security: []`);
      } else if (!operation.security?.length) {
        errors.push(`${key} must inherit or declare an authentication requirement`);
      }
    }
  }

  for (const key of PUBLIC_OPENAPI_OPERATION_KEYS) {
    if (!seenPublic.has(key)) errors.push(`declared public operation is absent: ${key}`);
  }
  for (const ref of new Set(collectRefs(json))) {
    if (!resolveLocalRef(json, ref)) errors.push(`unresolved or external $ref: ${ref}`);
  }
  if (operations < 100) errors.push(`operation count is unexpectedly low: ${operations}`);
  if (errors.length) fail(errors);

  // eslint-disable-next-line no-console
  console.log(
    `OpenAPI verified — paths=${Object.keys(json.paths).length}, operations=${operations}, schemas=${Object.keys(json.components?.schemas ?? {}).length}, public=${seenPublic.size}, summaries=${summaries}/${operations}`,
  );
}

main();
