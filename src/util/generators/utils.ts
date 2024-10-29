import {
  AttributeArgument,
  KeyValue,
  RelationArray,
  Value,
} from '@mrleebo/prisma-ast';
import {
  GeneratorError,
  type DMMF,
  type GeneratorOptions,
} from '@prisma/generator-helper';
import path from 'path';

export type FileToGenerate = { file: string; content: string };

function camelize(str: string) {
  return str
    .replace(/(?:^\w|[A-Z]|\b\w)/g, function (word, index) {
      return index === 0 ? word.toLowerCase() : word.toUpperCase();
    })
    .replace(/\s+/g, '');
}

type InterpolateTransformer = (
  key: string,
  data: Record<string, string>,
  option?: string
) => string;
const interpolateTransformers: Record<string, InterpolateTransformer> = {
  camelCase(key) {
    return camelize(key);
  },
  if(key, data, option) {
    const match = option?.match(/if\(([^)]+)\)(\?([^:]*):(.*))?$/);
    if (!match) return key;
    const [_, condStr, thenAndElse, thenStr, elseStr] = match;

    if (typeof condStr === 'string' && condStr in data && data[condStr]) {
      return thenAndElse ? `${key}${thenStr}` : key;
    }
    return thenAndElse ? `${key}${elseStr}` : '';
  },
};
export function interpolate(
  template: string,
  data: Record<string, string>,
  regExp: RegExp = /\{\{([^}|]*)(\|(([a-zA-Z0-9_]+)[^}]*))?\}\}/gm
) {
  return template.replace(
    regExp,
    (_, p1, _p2, p3, p4: keyof typeof interpolateTransformers | undefined) => {
      const transformer =
        p4 && interpolateTransformers[p4]
          ? interpolateTransformers[p4]
          : (x: string) => x;
      return transformer(data[p1] ?? '', data, p3);
    }
  );
}

export function getRelativePathWithoutExtension(pathA: string, pathB: string) {
  const schemaRelativePath = path.relative(path.dirname(pathA), pathB);
  const parsedPath = path.parse(schemaRelativePath);
  const filePathWithoutExtension = path.join(parsedPath.dir, parsedPath.name);
  return `${
    !filePathWithoutExtension.startsWith('.') ? './' : ''
  }${filePathWithoutExtension}`;
}

export type Index = {
  model: string;
  type: string;
  isDefinedOnField: string;
  dbName: string;
  algorithm: string;
  fields: {
    name: string;
    operatorClass: string;
  }[];
};

type AttributeArgumentCheckFn = (val: KeyValue | RelationArray) => boolean;

function getValue(
  arg: KeyValue | RelationArray | Value,
  check: AttributeArgumentCheckFn | undefined
): Value | undefined {
  if (typeof arg !== 'object') return arg;
  if ('type' in arg) {
    if (arg.type === 'keyValue')
      return !check || check(arg) ? getValue(arg.value, undefined) : undefined;
    if (arg.type === 'array')
      return !check || check(arg) ? getValue(arg.args, undefined) : undefined;
    if (arg.type === 'function') return undefined;
  }
  return arg;
}

function getUniqueIndexAttributeValue(
  args: AttributeArgument[],
  check: AttributeArgumentCheckFn
) {
  let fields: string[] | undefined;
  let i = 0;
  while (!fields) {
    const arg = args[i++];
    if (!arg) break;
    fields = getValue(arg.value, check) as string[] | undefined;
  }
  return fields;
}

export function getUniqueIndexAttributeFileds(args: AttributeArgument[]) {
  return getUniqueIndexAttributeValue(
    args,
    (val) => !('key' in val) || val.key === 'fields'
  );
}

export function getUniqueIndexAttributeName(args: AttributeArgument[]) {
  return getUniqueIndexAttributeValue(
    args,
    (val) => 'key' in val && val.key === 'name'
  );
}

export function getMaybeArrayFirstValue<T extends unknown>(
  maybeArr: T | T[]
): T | undefined {
  return Array.isArray(maybeArr) ? maybeArr[0] : maybeArr;
}

export type Templates = Record<string, string>;

export function getAllTemplatesFromConfig(
  config: GeneratorOptions['generator']['config'],
  searchKey: string,
  keyPrefix: string
): Templates {
  const result: Templates = {};
  Object.keys(config).forEach((key) => {
    if (key.startsWith(searchKey)) {
      const resultKey = `${keyPrefix}${key.replace(searchKey, '')}`;
      const value = getMaybeArrayFirstValue(config[key]);
      if (!value) return;
      result[resultKey] = value;
    }
  });
  return result;
}

export function mapValues<T, U, O extends Record<string, T>>(
  obj: O,
  mapper: (value: T, key: string, obj: O) => U
): Record<string, U> {
  const result: Record<string, U> = {};
  for (const key in obj) {
    if (!obj.hasOwnProperty(key)) continue;
    // @ts-ignore
    result[key] = mapper(obj[key], key, obj);
  }
  return result;
}

export function mapValuesFilterTruthy<T, U, O extends Record<string, T>>(
  ...args: Parameters<typeof mapValues<T, U, O>>
) {
  const result = mapValues(...args);
  Object.keys(result).forEach((key) => {
    if (!result[key]) delete result[key];
  });
  return result;
}

export function interpolateTemplates(
  templates: Templates,
  data: Record<string, string>
) {
  if (!templates) return {};
  const result: Templates = {};
  Object.keys(templates).forEach((key) => {
    result[key] = interpolate(templates[key]!, data);
  });
  return result;
}

export function getFieldForeignKeyField(
  field: DMMF.Field,
  fields: readonly DMMF.Field[]
): DMMF.Field | undefined {
  for (const relField of fields) {
    const { relationFromFields } = relField;
    if (!relationFromFields) continue;
    if (relationFromFields.includes(field.name)) {
      return relField;
    }
  }
  return;
}

export function getTSTypeModStrFromDocs({
  documentation,
  isRequired,
}: DMMF.Field) {
  if (documentation) {
    const match = documentation.match(/@tsType\((.*)\)/);
    if (match) {
      return `.$type<${match[1]}${isRequired ? '' : ' | null | undefined'}>()`;
    }
  }
  return '';
}

export function getFieldTypeAndConfigFromDocs(
  docs: DMMF.Field['documentation']
) {
  if (docs) {
    const match = docs.match(/@type\((.*?)(,\s*(.*))?\)/);
    if (match && match[1]) {
      return {
        type: match[1],
        config: match[3],
      };
    }
  }
  return undefined;
}

export function getDeleteAction(field: DMMF.Field): string {
  switch (field.relationOnDelete) {
    case 'Cascade':
      return 'cascade';
    case 'SetNull':
      return 'set null';
    case 'SetDefault':
      return 'set default';
    case 'Restrict':
      return 'restrict';
    case undefined:
    case 'NoAction':
      return 'no action';
    default:
      throw new GeneratorError(
        `Unknown delete action on relation ${field.relationName}: ${field.relationOnDelete}`
      );
  }
}
