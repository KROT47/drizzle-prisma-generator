# Drizzle Prisma Generator

Automatically generate Drizzle schema from Prisma schema

## Usage

- Install generator: `pnpm add -D drizzle-prisma-generator`
- Add generator to prisma:

```Prisma
generator drizzle {
  provider = "drizzle-prisma-generator"
  output = "./src/schema.ts"
  indexFileTemplate  = "{{imports}}\n\nexport interface Database {\n{{content}}\n}"
  indexModelTemplate = "\t{{dbName}}: typeof {{name}}"
}
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
  name String @db.VarChar(50)
  /// @type(tsvector)
  /// @.generatedAlwaysAs(sql`prepare_search_field(name)`)
  fts String
  deletedAt    DateTime? @db.Timestamptz(6)

  /// @.where(sql`"deletedAt" IS NULL`)
  @@unique([coordinates, name], name: "some_idx")
}
```

converts to:

```ts
export const Warehouse = pgTable(
  'warehouses',
  {
    coordinates: geometry({ type: 'point', srid: 4326 })
      .$type<SomeNamespace.SomeType>()
      .notNull()
      .default([123, 123]),
    name: varchar({ length: 50 }).notNull(),
    fts: tsvector()
      .generatedAlwaysAs(sql`prepare_search_field(name)`)
      .notNull(),
    deletedAt: timestamp({ mode: 'date', withTimezone: true, precision: 6 }),
  },
  (Warehouse) => ({
    some_idx: uniqueIndex('some_idx')
      .on(Warehouse.coordinates, Warehouse.name)
      .where(sql`"deletedAt" IS NULL`),
  })
);
```
