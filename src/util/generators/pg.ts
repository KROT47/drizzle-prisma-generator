import { s } from '@/util/escape';
import { extractManyToManyModels } from '@/util/extract-many-to-many-models';
import { UnReadonlyDeep } from '@/util/un-readonly-deep';
import {
  Attribute,
  AttributeArgument,
  BlockAttribute,
  Comment,
  createPrismaSchemaBuilder,
  Field,
  KeyValue,
  RelationArray,
  Value,
} from '@mrleebo/prisma-ast';
import {
  type DMMF,
  GeneratorError,
  type GeneratorOptions,
} from '@prisma/generator-helper';
import path from 'path';
import {
  FileToGenerate,
  getAllTemplatesFromConfig,
  getDeleteAction,
  getFieldForeignKeyField,
  getFieldTypeAndConfigFromDocs,
  getMaybeArrayFirstValue,
  getRelativePathWithoutExtension,
  getTSTypeModStrFromDocs,
  getUniqueIndexAttributeFileds,
  getUniqueIndexAttributeName,
  Index,
  interpolate,
  interpolateTemplates,
  mapValues,
  mapValuesFilterTruthy,
  Templates,
} from './utils';

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

let typeImportsPath: string | undefined;
const pgImports = new Set<string>();
const drizzleImports = new Set<string>();
const constants = new Map<string, string>();
pgImports.add('pgTable');

const modsRegExp = /@(\.[^(]+\(.*\))/g;

function getModsFromDocs(docs: string) {
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

const dbSpecialTypes = {
  Uuid: {
    type: 'uuid',
    getConfig(attribute: Attribute) {},
  },
  SmallInt: {
    type: 'smallint',
    getConfig(attribute: Attribute) {},
  },
  Real: {
    type: 'real',
    getConfig(attribute: Attribute) {},
  },
  Timestamptz: {
    type: 'timestamp',
    getConfig(attribute: Attribute) {
      const config = {
        mode: 'date',
        withTimezone: true,
        precision: 6,
      };
      const precision = attribute.args?.find(
        ({ type }) => type === 'attributeArgument'
      )?.value;
      if (precision) {
        config.precision = Number(precision);
      }
      return config;
    },
  },
  VarChar: {
    type: 'varchar',
    getConfig(attribute: Attribute) {
      const length = attribute.args?.find(
        ({ type }) => type === 'attributeArgument'
      )?.value;
      if (!length) return;
      return {
        length: Number(length),
      };
    },
  },
};
function getDbSpecialTypeAndConfigStr(attributes: Attribute[]) {
  for (const [key, value] of Object.entries(dbSpecialTypes)) {
    const attr = attributes.find(
      ({ name, group }) => group === 'db' && name === key
    );
    if (!attr) continue;

    const config = value.getConfig?.(attr);
    return {
      type: value.type,
      config: config ? JSON.stringify(config) : undefined,
    };
  }
  return undefined;
}

const prismaToDrizzleType = (
  type: string,
  _defVal?: string | unknown[],
  docs?: DMMF.Field['documentation']
) => {
  const defVal =
    (Array.isArray(_defVal)
      ? _defVal.map((x) => JSON.stringify(x)).join(', ')
      : _defVal) ?? '';
  switch (type.toLowerCase()) {
    case 'real':
      pgImports.add('real');
      return `real()`;
    case 'varchar':
      pgImports.add('varchar');
      return `varchar(${defVal})`;
    case 'uuid':
      pgImports.add('uuid');
      return `uuid()`;
    case 'tsvector':
      registerTsvectorFn();
      return `tsvector(${defVal})`;
    case 'geometry':
      pgImports.add('geometry');
      return `geometry(${defVal})`;
    case 'smallint':
      if (defVal === 'autoincrement') {
        pgImports.add('smallserial');
        return `smallserial()`;
      }

      pgImports.add('smallint');
      return `smallint()`;
    case 'bigint':
      if (defVal === 'autoincrement') {
        pgImports.add('bigserial');
        return `bigserial({ mode: 'number' })`;
      }

      pgImports.add('bigint');
      return `bigint({ mode: 'number' })`;
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
      return `timestamp(${defVal})`;
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
      return `jsonb()`;
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
      if (type.startsWith('imports.')) {
        return `${type}(${defVal})`;
      }
      return undefined;
  }
};

const addColumnModifiers = (
  field: DMMF.Field,
  column: string,
  fields: readonly DMMF.Field[],
  attributes?: Attribute[]
) => {
  if (field.documentation) {
    const mods = getModsFromDocs(field.documentation);
    mods.forEach((mod) => {
      column += mod;
    });

    const tsTypeMod = getTSTypeModStrFromDocs(field);
    column += tsTypeMod;
  }

  if (field.isList) column += `.array()`;
  if (field.isRequired) column += `.notNull()`;
  if (field.isId) column += `.primaryKey()`;
  if (field.isUnique) column += `.unique()`;

  if (field.default) {
    const defVal = field.default;

    switch (typeof defVal) {
      case 'number':
      case 'string':
      case 'symbol':
      case 'boolean':
        column += `.default(${JSON.stringify(defVal)})`;
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
          column += `.defaultNow()`;
          break;
        }

        if (value.name === 'autoincrement') {
          break;
        }

        if (value.name === 'dbgenerated') {
          column += `.default(sql\`${s(value.args[0], '`')}\`)`;

          drizzleImports.add('sql');
          break;
        }

        if (/^uuid\([0-9]*\)$/.test(value.name)) {
          column += `.default(sql\`uuid()\`)`;

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
        column += `.default(${sequel})`;
        break;
    }
  }

  if (attributes?.some(({ name }) => name === 'updatedAt')) {
    column += '.defaultNow().$onUpdate(() => sql`now()`)';
  }

  const fkField = getFieldForeignKeyField(field, fields);
  if (fkField) {
    const { type, relationToFields } = fkField;
    if (relationToFields) {
      const deleteAction = getDeleteAction(fkField);
      column += `.references((): AnyPgColumn => ${type}.${relationToFields[0]}, {onDelete: '${deleteAction}'})`;
    }
  }

  return column;
};

const prismaToDrizzleColumn = (
  field: DMMF.Field,
  fields: readonly DMMF.Field[],
  attributes?: Attribute[]
): string | undefined => {
  const colDbName = s(field.dbName ?? field.name);
  let column = `\t${field.name}: `;

  if (field.kind === 'enum') {
    column += `${field.type}('${colDbName}')`;
  } else {
    let defVal;
    let type = field.type;
    const { default: defaultVal } = field;
    let typeAndConfigFromDocs = getFieldTypeAndConfigFromDocs(
      field.documentation
    );
    if (typeAndConfigFromDocs) {
      type = typeAndConfigFromDocs.type;
      defVal = typeAndConfigFromDocs.config;
    } else if (attributes) {
      const typeAndConfig = getDbSpecialTypeAndConfigStr(attributes);
      if (typeAndConfig) {
        type = typeAndConfig.type;
        defVal = typeAndConfig.config;
      }
    }

    if (!defVal && typeof defaultVal === 'object' && 'name' in defaultVal) {
      defVal = defaultVal.name;
    }

    const drizzleType = prismaToDrizzleType(type, defVal, field.documentation);
    if (!drizzleType) return undefined;

    column += drizzleType;
  }

  column = addColumnModifiers(field, column, fields, attributes);

  return column;
};

export const generatePgSchema = (options: GeneratorOptions) => {
  const schemaPath = options.generator.output?.value as string;
  const importsPath =
    'imports' in options.generator.config
      ? getMaybeArrayFirstValue(options.generator.config['imports'])
      : undefined;
  if (importsPath) {
    typeImportsPath = getRelativePathWithoutExtension(schemaPath, importsPath);
  }

  const config = options.generator.config;
  const optionsKeys = Object.keys(config);
  const fileKeysToGenerate = optionsKeys.filter((key) => key.match(/file\d/));
  const fileConfigsToGenerate = fileKeysToGenerate.map((key) => {
    const index = key.match(/file(\d+)/)?.[1];
    if (!index) throw Error('File index not found');
    return {
      file: getMaybeArrayFirstValue(config[`file${index}`]),
      template: getMaybeArrayFirstValue(config[`template${index}`]),
      typeMapImports: getAllTemplatesFromConfig(
        config,
        `template${index}_typeMapImports`,
        'typeMapImports'
      ),
      content: getAllTemplatesFromConfig(
        config,
        `template${index}_content`,
        'content'
      ),
      importedTypesContent: getAllTemplatesFromConfig(
        config,
        `template${index}_importedTypesContent`,
        'importedTypesContent'
      ),
      importedTypesMap: getAllTemplatesFromConfig(
        config,
        `template${index}_importedTypesMap`,
        'importedTypesMap'
      ),
    };
  });

  const { datamodel } = options.dmmf;
  const { models, enums } = datamodel;
  const modelsIndexes =
    'indexes' in datamodel && (datamodel.indexes as unknown as Index[]);

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

  const prismaSchemaAstBuilder = createPrismaSchemaBuilder(options.datamodel);

  for (const schemaTable of modelsWithImplicit) {
    const modelAst = prismaSchemaAstBuilder.findByType('model', {
      name: schemaTable.name,
    });
    if (!modelAst) {
      throw new Error(`Model ${schemaTable.name} not found in schema`);
    }

    const tableDbName = s(schemaTable.dbName ?? schemaTable.name);

    const columnFields = Object.fromEntries(
      schemaTable.fields
        .map((field) => {
          const fieldAst = prismaSchemaAstBuilder.findByType('field', {
            name: field.name,
            within: modelAst.properties,
          });

          if (!fieldAst) {
            throw new Error(`Model ${modelAst.name} not found in schema`);
          }

          return [
            field.name,
            prismaToDrizzleColumn(
              field,
              schemaTable.fields,
              fieldAst.attributes
            ),
          ];
        })
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

    if (schemaTable.uniqueIndexes.length) {
      pgImports.add('uniqueIndex');

      const uniqueIndexes: (BlockAttribute & { comments: Comment[] })[] = [];
      let prevComments: Comment[] = [];
      modelAst.properties.forEach((prop) => {
        if (prop.type === 'comment') {
          prevComments.push(prop);
          return;
        }
        if (prop.type === 'attribute' && prop.name === 'unique') {
          uniqueIndexes.push({
            ...prop,
            comments: prevComments ?? [],
          });
        }
        prevComments = [];
      });

      const uniques = uniqueIndexes.map(({ name, args, comments }) => {
        const fields = getUniqueIndexAttributeFileds(args);

        if (!fields || !fields.length) throw Error('No fields on unique index');

        const _idxName = getUniqueIndexAttributeName(args) as unknown as string;

        const idxName = s(
          _idxName ?? `${schemaTable.name}_${fields.join('_')}_key`
        );

        const mods = comments.map(({ text }) => getModsFromDocs(text)).flat();

        return `\t'${
          name ? idxName : `${idxName.slice(0, idxName.length - 4)}_unique_idx`
        }': uniqueIndex('${idxName}')\n\t\t.on(${fields
          .map((f) => `${schemaTable.name}.${f}`)
          .join(', ')})${mods ? mods.join('') : ''}`;
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

    const relFields = schemaTable.fields.filter(
      (field) => field.relationToFields && field.relationFromFields
    );

    if (!relFields.length) continue;
    pgImports.add('AnyPgColumn');
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

  const filesToGenerate: FileToGenerate[] = [];

  if (fileConfigsToGenerate.length) {
    fileConfigsToGenerate.forEach((fileConfig) => {
      const file = fileConfig.file;
      const _template = fileConfig.template;
      const _content = fileConfig.content;

      if (!file || !_template || !_content) return;

      const schemaRelativePath = getRelativePathWithoutExtension(
        file,
        schemaPath
      );

      const imports: string[] = [];
      const fieldTypeImports = new Set<string>();

      const content: Templates = mapValues<string, string, Templates>(
        _content,
        (template) =>
          models
            .map((model) => {
              imports.push(model.name);
              const localFieldTypesImports: Partial<DMMF.Field>[] = [];

              model.fields.forEach((field) => {
                const specialType = getFieldTypeAndConfigFromDocs(
                  field.documentation
                )?.type;
                if (specialType?.startsWith('imports.')) {
                  const fieldType = specialType.split('imports.')[1]!;
                  localFieldTypesImports.push({ ...field, type: fieldType });
                  fieldTypeImports.add(fieldType);
                }
              });

              const _importedTypesMap = fileConfig.importedTypesMap;
              const importedTypesMap = Object.keys(_importedTypesMap).length
                ? mapValuesFilterTruthy<string, string, Templates>(
                    _importedTypesMap,
                    (template) =>
                      localFieldTypesImports
                        .map((data) =>
                          interpolate(template, data as Record<string, string>)
                        )
                        .join('')
                  )
                : {};

              const _importedTypesContent = fileConfig.importedTypesContent;
              const importedTypesContent =
                Object.keys(_importedTypesContent).length &&
                Object.keys(importedTypesMap).length
                  ? interpolateTemplates(
                      _importedTypesContent,
                      importedTypesMap
                    )
                  : {};

              return interpolate(template, {
                ...importedTypesContent,
                tableName: model.dbName ?? '',
                modelName: model.name,
              });
            })
            .join('\n')
      );

      const _typeMapImports = fileConfig.typeMapImports;
      const typeMapImports = _typeMapImports
        ? mapValues<string, string, Templates>(_typeMapImports, (template) =>
            [...fieldTypeImports]
              .map((fieldType) => interpolate(template, { fieldType }))
              .join('')
          )
        : {};

      const result =
        '// generated by drizzle-prisma-generator\n' +
        interpolate(_template, {
          ...content,
          ...typeMapImports,
          imports: `import {\n  ${imports.join(
            ',\n  '
          )},\n} from '${schemaRelativePath}'`,
        });

      filesToGenerate.push({
        file: file,
        content: result,
      });
    });
  }

  return [output, filesToGenerate] as [string, FileToGenerate[]];
};
