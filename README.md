# Drizzle Prisma Generator

Automatically generate Drizzle schema from Prisma schema

## Usage

- Install generator: `pnpm add -D drizzle-prisma-generator`
- Add generator to prisma:

```Prisma
generator drizzle {
  provider = "drizzle-prisma-generator"
  output   = "./src/schema.ts"
  imports  = "./drizzleSchemaUtils.ts"

  // add postfix to each table model's name (optional, default: "Table")
  modelPostfix = "SomePostfix"

  // add postfix to each enum (optional, default: "Enum")
  enumPostfix = "EnumPostfix"

  // tells if relations should be exported from drizzle schema (optional, default: false)
  exportRelations = true

  // convert to Kysely types
  file1             = "./kyselyDatabase.ts"
  template1         = "import { Kyselify } from 'drizzle-orm/kysely'\n\n{{imports}}\n\nexport interface Database {\n{{content}}\n}"
  template1_content = "\t'{{tableSchema|if(tableSchema)?.:}}{{tableName}}': Kyselify<typeof {{modelName}}>"

  // convert to Zod types
  file2                           = "./drizzleZodSchemas.ts"
  // file layout template which receives `typeMapImports` and `content`
  template2                       = "import { createInsertSchema, createSelectSchema } from 'drizzle-zod'\n\n{{imports}}\nimport {\n{{typeMapImports}}} from './drizzleSchemaUtils'\n\n{{content}}"
  // mapping for each imported type (using @type(imports.<type>))
  template2_typeMapImports        = "\t{{fieldType}}DataSchema,\n"
  // file content template
  template2_content               = "export const {{baseModelName|camelCase}}Schema = createSelectSchema({{modelName}}){{importedTypesContent}}\nexport const {{baseModelName|camelCase}}InsertSchema = createInsertSchema({{modelName}}){{importedTypesContent}}\nconst {{modelName|camelCase}}PrimaryKey = {{fieldsContent1}}\nconst {{modelName|camelCase}}PrimaryKeyLower = {{fieldsContent2}}\n"
  // content for all imported types which receives importedTypesMap
  template2_importedTypesContent  = ".extend({\n{{importedTypesMap}}})"
  // mapping for each imported type (using @type(imports.<type>))
  // receives all field data, look below at Field Type section
  template2_importedTypesMap      = "  {{name}}: {{type}}DataSchema{{|if(isRequired)?:.nullable()}},\n"
  // content to insert fieldsMap into
  template2_fieldsContent1 = "{{fieldsMap}}"
  // any other variable may be created by adding number to the end
  template2_fieldsContent2 = "{{fieldsMap}}.toLowerCase()"
  // mapping for each field in model (check out all field props below, e.g. isId)
  // e.g. here prints field name if it is primary key
  template2_fieldsMap     = "{{name|if(isId)}}"
}
```

#### Field type (DMMF.Field)

```ts
type Field = ReadonlyDeep<{
  kind: FieldKind;
  name: string;
  isRequired: boolean;
  isList: boolean;
  isUnique: boolean;
  isId: boolean;
  isReadOnly: boolean;
  isGenerated?: boolean;
  isUpdatedAt?: boolean;
  /**
   * Describes the data type in the same the way it is defined in the Prisma schema:
   * BigInt, Boolean, Bytes, DateTime, Decimal, Float, Int, JSON, String, $ModelName
   */
  type: string;
  dbName?: string | null;
  hasDefaultValue: boolean;
  default?: FieldDefault | FieldDefaultScalar | FieldDefaultScalar[];
  relationFromFields?: string[];
  relationToFields?: string[];
  relationOnDelete?: string;
  relationName?: string;
  documentation?: string;
}>;
```

:warning: - if output doesn't end with `.ts`, it will be treated like a folder, and schema will be generated to `schema.ts` inside of it.  
:warning: - binary types in `MySQL`, `PostgreSQL` are not yet supported by `drizzle-orm`, therefore will throw an error.  
:warning: - generator only supports `postgresql`, `mysql`, `sqlite` data providers, others will throw an error.

- Install `drizzle-orm`: `pnpm add drizzle-orm`
- Import schema from specified output file\folder
- Congratulations, now you can use Drizzle ORM with generated schemas!

## Using any types (improved for pg only)

Use documentation with `@type`, `@tsType` and `@.<anyDrizzleFieldMethod>(...)`

```prisma
model Warehouse {
  /// @type(geometry, { type: 'point', srid: 4326 })
  /// @tsType(SomeNamespace.SomeType)
  coordinates Json @default([123, 123])
  /// @type(imports.polygon, { srid: 4326 })
  polygon     Json?
  name        String @db.VarChar(50)
  /// @type(tsvector)
  /// @.generatedAlwaysAs(sql`prepare_search_field(name)`)
  fts         String
  /// @check(sql`"age" >= 21`)
  age         Int
  deletedAt   DateTime? @db.Timestamptz(6)

  /// @.where(sql`"deletedAt" IS NULL`)
  @@unique([coordinates, name], name: "some_idx")
  @@map("warehouses")
}
```

converts to:

```ts
import * as imports from './drizzleSchemaUtils';

export const WarehouseSomePostfix = pgTable(
  'warehouses',
  {
    coordinates: geometry({ type: 'point', srid: 4326 })
      .$type<SomeNamespace.SomeType>()
      .notNull()
      .default([123, 123]),
    polygon: imports.polygon({ srid: 4326 }),
    name: varchar({ length: 50 }).notNull(),
    fts: tsvector()
      .generatedAlwaysAs(sql`prepare_search_field(name)`)
      .notNull(),
    deletedAt: timestamp({ mode: 'date', withTimezone: true, precision: 6 }),
  },
  (Warehouse) => ({
    warehouses_age_check1: check('warehouses_age_check_1', sql`"age" >= 21`),
    some_idx: uniqueIndex('some_idx')
      .on(Warehouse.coordinates, Warehouse.name)
      .where(sql`"deletedAt" IS NULL`),
  })
);
```

#### Generated files:

`./kyselyDatabase.ts`:

```ts
// generated by drizzle-prisma-generator
import { Kyselify } from 'drizzle-orm/kysely';

import { WarehouseSomePostfix } from './drizzleSchema';

export interface Database {
  warehouses: Kyselify<typeof WarehouseSomePostfix>;
}
```

`./drizzleZodSchemas.ts`:

```ts
// generated by drizzle-prisma-generator
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';

import { WarehouseSomePostfix } from './drizzleSchema';
import { polygonDataSchema } from './drizzleSchemaUtils';

export const warehouseSchema = createSelectSchema(WarehouseSomePostfix).extend({
  polygon: polygonDataSchema.nullable(),
});
export const warehouseInsertSchema = createInsertSchema(
  WarehouseSomePostfix
).extend({
  polygon: polygonDataSchema.nullable(),
});
```

#### Imports file example:

`./drizzleSchemaUtils.ts`:

```ts
import { customType } from 'drizzle-orm/pg-core';
import { z } from 'zod';

export const polygonDataSchema = z.array(z.tuple([z.number(), z.number()]));
export type PolygonData = z.infer<typeof polygonDataSchema>;

export const polygon = customType<{ data: PolygonData; driverData: string }>({
  dataType() {
    return 'geometry(polygon)';
  },
});
```
