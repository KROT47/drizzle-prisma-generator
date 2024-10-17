import { s } from '@/util/escape';
import { extractManyToManyModels } from '@/util/extract-many-to-many-models';
import { UnReadonlyDeep } from '@/util/un-readonly-deep';
import {
  type DMMF,
  GeneratorError,
  type GeneratorOptions,
} from '@prisma/generator-helper';
import path from 'path';

function registerTsvectorFn() {
  pgImports.add('customType');
  constants.set(
    'tsvector',
    `const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});`
  );
}

type Field = DMMF.Field & { with?: string; mods?: Record<string, string> };

let typeImportsPath: string | undefined;
const pgImports = new Set<string>();
const drizzleImports = new Set<string>();
const constants = new Map<string, string>();
pgImports.add('pgTable');

function getTSTypeModStrFromDocs(docs: Field['documentation']) {
  if (docs) {
    const match = docs.match(/@tsType\((.*)\)/);
    if (match) {
      return `.$type<${match[1]}>()`;
    }
  }
  return '';
}

function getFieldTypeFromDocs(docs: Field['documentation']) {
  if (docs) {
    const match = docs.match(/@type\((.*)\)/);
    if (match) {
      return match[1];
    }
  }
  return '';
}

const modsRegExp = /@(\.[^(]+\(.*\))/g;

function getModsFromDocs(docs: Field['documentation']) {
  const mods: string[] = [];
  if (docs) {
    let result: RegExpExecArray | null;
    while ((result = modsRegExp.exec(docs)) !== null) {
      if (!result[1]) continue;
      mods.push(result[1]);
    }
  }
  if (mods.length) {
    // maybe there are sql in mods
    drizzleImports.add('sql');
  }
  return mods;
}

const prismaToDrizzleType = (
  type: string,
  _defVal?: string | unknown[],
  docs?: Field['documentation']
) => {
  const defVal = Array.isArray(_defVal)
    ? _defVal.map((x) => JSON.stringify(x)).join(', ')
    : _defVal;
  switch (type.toLowerCase()) {
    case 'tsvector':
      registerTsvectorFn();
      return `tsvector(${defVal ?? ''})`;
    case 'geometry':
      pgImports.add('geometry');
      return `geometry(${defVal})`;
    case 'bigint':
      pgImports.add('bigint');
      return `bigint({ mode: 'bigint' })`;
    case 'boolean':
      pgImports.add('boolean');
      return `boolean()`;
    case 'bytes':
      // Drizzle doesn't support it yet...
      throw new GeneratorError(
        "Drizzle ORM doesn't support binary data type for PostgreSQL"
      );
    case 'datetime':
    case 'timestamp':
      pgImports.add('timestamp');
      return `timestamp()`;
    case 'decimal':
      pgImports.add('decimal');
      return `decimal({ precision: 65, scale: 30 })`;
    case 'float':
    case 'doublePrecision':
      pgImports.add('doublePrecision');
      return `doublePrecision()`;
    case 'json':
    case 'jsonb':
      pgImports.add('jsonb');
      return `jsonb()${docs ? getTSTypeModStrFromDocs(docs) : ''}`;
    case 'int':
    case 'integer':
      if (defVal === 'autoincrement') {
        pgImports.add('serial');
        return `serial()`;
      }

      pgImports.add('integer');
      return `integer()`;
    case 'string':
    case 'text':
      pgImports.add('text');
      return `text()`;
    default:
      return undefined;
  }
};

const addColumnModifiers = (field: Field, column: string) => {
  if (field.documentation) {
    const mods = getModsFromDocs(field.documentation);
    mods.forEach((mod) => {
      column = column + mod;
    });
  }
  if (field.mods) {
    column =
      column +
      Object.entries(field.mods)
        .map(([key, value]) => `.${key}(${value})`)
        .join('');
  }
  if (field.with) column = column + field.with;
  if (field.isList) column = column + `.array()`;
  if (field.isRequired) column = column + `.notNull()`;
  if (field.isId) column = column + `.primaryKey()`;
  if (field.isUnique) column = column + `.unique()`;

  if (field.default) {
    const defVal = field.default;

    switch (typeof defVal) {
      case 'number':
      case 'string':
      case 'symbol':
      case 'boolean':
        column = column + `.default(${JSON.stringify(defVal)})`;
        break;
      case 'object':
        if (Array.isArray(defVal)) {
          column =
            column +
            `.default([${defVal.map((e) => JSON.stringify(e)).join(', ')}])`;
          break;
        }

        const value = defVal as {
          name: string;
          args: any[];
        };

        if (value.name === 'now') {
          column = column + `.defaultNow()`;
          break;
        }

        if (value.name === 'autoincrement') {
          break;
        }

        if (value.name === 'dbgenerated') {
          column = column + `.default(sql\`${s(value.args[0], '`')}\`)`;

          drizzleImports.add('sql');
          break;
        }

        if (/^uuid\([0-9]*\)$/.test(value.name)) {
          column = column + `.default(sql\`uuid()\`)`;

          drizzleImports.add('sql');
          break;
        }

        const stringified = `${value.name}${
          value.args.length
            ? '(' + value.args.map((e) => String(e)).join(', ') + ')'
            : value.name.endsWith(')')
            ? ''
            : '()'
        }`;
        const sequel = `sql\`${s(stringified, '`')}\``;

        drizzleImports.add('sql');
        column = column + `.default(${sequel})`;
        break;
    }
  }

  return column;
};

const prismaToDrizzleColumn = (_field: Field): string | undefined => {
  const field = { ..._field };
  const colDbName = s(field.dbName ?? field.name);
  let column = `\t${field.name}: `;

  // if (field.name === 'webId') {
  //   // eslint-disable-next-line
  //   console.log('>>>214', field);
  // }

  if (field.kind === 'enum') {
    column = column + `${field.type}('${colDbName}')`;
  } else {
    let defVal;
    let type = field.type;
    const { default: defaultVal } = field;
    let typeFromDocs = getFieldTypeFromDocs(field.documentation);
    if (typeFromDocs) {
      type = typeFromDocs;
    } else if (typeof defaultVal === 'object' && 'name' in defaultVal) {
      if (
        type === 'Bytes' &&
        defaultVal.name === 'dbgenerated' &&
        typeof defaultVal.args[0] === 'string'
      ) {
        try {
          const filedConfig = eval(`(${defaultVal.args[0]})`);
          if (typeof filedConfig !== 'object') {
            throw Error(`Invalid field config`);
          }
          type = filedConfig.type;
          defVal = filedConfig.args;
          field.mods = filedConfig.mods;
          field.with = filedConfig.with;
          field.default = filedConfig.default;
        } catch (e) {
          throw Error(`Error in ${field.name}: ${(e as Error).message}`);
        }
      } else {
        defVal = defaultVal.name;
      }
    }

    const drizzleType = prismaToDrizzleType(type, defVal, field.documentation);
    if (!drizzleType) return undefined;

    column = column + drizzleType;
  }

  column = addColumnModifiers(field, column);

  return column;
};

type Index = {
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

export const generatePgSchema = (options: GeneratorOptions) => {
  // eslint-disable-next-line
  console.log('>>>275', options.dmmf);

  const importsPath =
    'imports' in options.generator.config
      ? [options.generator.config['imports']].flat()[0]
      : undefined;
  if (importsPath) {
    const schemaPath = options.generator.output?.value as string;

    const schemaDirPath = path.dirname(schemaPath);

    typeImportsPath = path.relative(schemaDirPath, importsPath);
  }
  const { datamodel } = options.dmmf;
  const { models, enums } = datamodel;
  const modelsIndexes =
    'indexes' in datamodel && (datamodel.indexes as Index[]);

  const clonedModels = JSON.parse(JSON.stringify(models)) as UnReadonlyDeep<
    DMMF.Model[]
  >;

  const manyToManyModels = extractManyToManyModels(clonedModels);

  const modelsWithImplicit = [
    ...clonedModels,
    ...manyToManyModels,
  ] as DMMF.Model[];

  const pgEnums: string[] = [];

  for (const schemaEnum of enums) {
    if (!schemaEnum.values.length) continue;
    const enumDbName = s(schemaEnum.dbName ?? schemaEnum.name);

    pgImports.add('pgEnum');

    pgEnums.push(
      `export const ${
        schemaEnum.name
      } = pgEnum('${enumDbName}', [${schemaEnum.values
        .map((e) => `'${e.dbName ?? e.name}'`)
        .join(', ')}])`
    );
  }

  const tables: string[] = [];
  const rqb: string[] = [];

  for (const schemaTable of modelsWithImplicit) {
    const tableDbName = s(schemaTable.dbName ?? schemaTable.name);

    const columnFields = Object.fromEntries(
      schemaTable.fields
        .map((e) => [e.name, prismaToDrizzleColumn(e)])
        .filter((e) => e[1] !== undefined)
    );

    const indexes: string[] = (modelsIndexes || [])
      .filter(
        ({ model, type }) => model === schemaTable.name && type === 'normal'
      )
      .map(({ dbName, algorithm, fields }) => {
        pgImports.add('index');
        const indexName =
          dbName ??
          (fields[0]?.name
            ? `${tableDbName}_${fields[0].name}_idx`
            : undefined);
        if (!indexName) return '';
        drizzleImports.add('sql');
        return `\t${indexName}: index('${indexName}')${fields
          .map(
            ({ name, operatorClass }) =>
              `.using('${algorithm.toLowerCase()}', 
            sql\`"${name}"${operatorClass ? ` ${operatorClass}` : ''}\`)`
          )
          .join('')}`;
      });

    const relFields = schemaTable.fields.filter(
      (field) => field.relationToFields && field.relationFromFields
    );
    const relations = relFields
      .map<string | undefined>((field) => {
        if (!field?.relationFromFields?.length) return undefined;

        const fkeyName = s(
          `${schemaTable.dbName ?? schemaTable.name}_${
            field.dbName ?? field.name
          }_fkey`
        );
        let deleteAction: string;
        switch (field.relationOnDelete) {
          case undefined:
          case 'Cascade':
            deleteAction = 'cascade';
            break;
          case 'SetNull':
            deleteAction = 'set null';
            break;
          case 'SetDefault':
            deleteAction = 'set default';
            break;
          case 'Restrict':
            deleteAction = 'restrict';
            break;
          case 'NoAction':
            deleteAction = 'no action';
            break;
          default:
            throw new GeneratorError(
              `Unknown delete action on relation ${fkeyName}: ${field.relationOnDelete}`
            );
        }

        pgImports.add('foreignKey');

        return `\t'${fkeyName}': foreignKey({\n\t\tname: '${fkeyName}',\n\t\tcolumns: [${field.relationFromFields
          .map((rel) => `${schemaTable.name}.${rel}`)
          .join(', ')}],\n\t\tforeignColumns: [${field
          .relationToFields!.map((rel) => `${field.type}.${rel}`)
          .join(', ')}]\n\t})${
          deleteAction && deleteAction !== 'no action'
            ? `\n\t\t.onDelete('${deleteAction}')`
            : ''
        }\n\t\t.onUpdate('cascade')`;
      })
      .filter((e) => e !== undefined) as string[];

    indexes.push(...relations);

    if (schemaTable.uniqueIndexes.length) {
      pgImports.add('uniqueIndex');

      const uniques = schemaTable.uniqueIndexes.map((idx) => {
        const idxName = s(
          idx.name ?? `${schemaTable.name}_${idx.fields.join('_')}_key`
        );
        // _key comes from Prisma, if their AI is to be trusted

        return `\t'${
          idx.name
            ? idxName
            : `${idxName.slice(0, idxName.length - 4)}_unique_idx`
        }': uniqueIndex('${idxName}')\n\t\t.on(${idx.fields
          .map((f) => `${schemaTable.name}.${f}`)
          .join(', ')})`;
      });

      indexes.push(...uniques);
    }

    if (schemaTable.primaryKey) {
      pgImports.add('primaryKey');

      const pk = schemaTable.primaryKey!;
      const pkName = s(pk.name ?? `${schemaTable.name}_cpk`);

      const pkField = `\t'${pkName}': primaryKey({\n\t\tname: '${pkName}',\n\t\tcolumns: [${pk.fields
        .map((f) => `${schemaTable.name}.${f}`)
        .join(', ')}]\n\t})`;

      indexes.push(pkField);
    }

    const table = `export const ${
      schemaTable.name
    } = pgTable('${tableDbName}', {\n${Object.values(columnFields).join(
      ',\n'
    )}\n}${
      indexes.length
        ? `, (${schemaTable.name}) => ({\n${indexes.join(',\n')}\n})`
        : ''
    });`;

    tables.push(table);

    if (!relFields.length) continue;
    drizzleImports.add('relations');

    const relationArgs = new Set<string>();
    const rqbFields = relFields
      .map((field) => {
        relationArgs.add(field.relationFromFields?.length ? 'one' : 'many');
        const relName = s(field.relationName ?? '');

        return `\t${field.name}: ${
          field.relationFromFields?.length
            ? `one(${
                field.type
              }, {\n\t\trelationName: '${relName}',\n\t\tfields: [${field.relationFromFields
                .map((e) => `${schemaTable.name}.${e}`)
                .join(', ')}],\n\t\treferences: [${field
                .relationToFields!.map((e) => `${field.type}.${e}`)
                .join(', ')}]\n\t})`
            : `many(${field.type}, {\n\t\trelationName: '${relName}'\n\t})`
        }`;
      })
      .join(',\n');

    const argString = Array.from(relationArgs.values()).join(', ');

    const rqbRelation = `export const ${schemaTable.name}Relations = relations(${schemaTable.name}, ({ ${argString} }) => ({\n${rqbFields}\n}));`;

    rqb.push(rqbRelation);
  }

  const drizzleImportsArr = Array.from(drizzleImports.values()).sort((a, b) =>
    a.localeCompare(b)
  );
  const drizzleImportsStr = drizzleImportsArr.length
    ? `import { ${drizzleImportsArr.join(', ')} } from 'drizzle-orm'`
    : undefined;

  const pgImportsArr = Array.from(pgImports.values()).sort((a, b) =>
    a.localeCompare(b)
  );
  const pgImportsStr = pgImportsArr.length
    ? `import { ${pgImportsArr.join(', ')} } from 'drizzle-orm/pg-core'`
    : undefined;

  let importsStr: string | undefined = [drizzleImportsStr, pgImportsStr]
    .filter((e) => e !== undefined)
    .join('\n');
  if (!importsStr.length) importsStr = undefined;

  const typeImportsStr = typeImportsPath
    ? `import * as imports from '${typeImportsPath}'`
    : '';

  const constantsStr = [...constants.values()].join('\n\n');

  const output = [
    importsStr,
    typeImportsStr,
    constantsStr,
    ...pgEnums,
    ...tables,
    ...rqb,
  ]
    .filter((e) => e !== undefined)
    .join('\n\n');

  return output;
};
