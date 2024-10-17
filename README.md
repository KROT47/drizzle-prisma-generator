# Drizzle Prisma Generator

Automatically generate Drizzle schema from Prisma schema

## Usage

- Install generator: `pnpm add -D drizzle-prisma-generator`
- Add generator to prisma:

```Prisma
generator drizzle {
  provider = "drizzle-prisma-generator"
  output = "./src/schema.ts"
}
```

:warning: - if output doesn't end with `.ts`, it will be treated like a folder, and schema will be generated to `schema.ts` inside of it.  
:warning: - binary types in `MySQL`, `PostgreSQL` are not yet supported by `drizzle-orm`, therefore will throw an error.  
:warning: - generator only supports `postgresql`, `mysql`, `sqlite` data providers, others will throw an error.

- Install `drizzle-orm`: `pnpm add drizzle-orm`
- Import schema from specified output file\folder
- Congratulations, now you can use Drizzle ORM with generated schemas!

## HACK to use unsupported prisma types (improved for pg only)

Define type `Bytes` with dbgenerated:

- type (string) - drizzle type to use
- args (array) - arguments to pass to type generator
- default (expected type) - default value

Or use documentation with `@type`, `@tsType` and `@.<anyDrizzleFieldMethod>(...)`

```prisma
model Warehouse {
  coordinates Bytes @default(dbgenerated("{ type: 'geometry', args: [{ type: 'point', srid: 4326 }], default: [123, 123] }"))
  name String
  fts1 Bytes  @default(dbgenerated("{ type: 'text', with: '.generatedAlwaysAs(sql`prepare_search_field(name)`)' }"))
  /// @tsType(SomeNamespace.SomeType)
  /// @type(tsvector)
  /// @.generatedAlwaysAs(sql`prepare_search_field(name)`)
  fts2 String
}
```

converts to:

```ts
export const Warehouse = pgTable('warehouses', {
  coordinates: geometry({ type: 'point', srid: 4326 })
    .notNull()
    .default([123, 123]),
  name: text().notNull(),
  fts1: text()
    .generatedAlwaysAs(sql`prepare_search_field(name)`)
    .notNull(),
  fts2: tsvector()
    .$type<SomeNamespace.SomeType>()
    .generatedAlwaysAs(sql`prepare_search_field(name)`)
    .notNull(),
});
```
