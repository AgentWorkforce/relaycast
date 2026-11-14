import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Engine SQL must be dialect-neutral: SQLite-only functions and syntax are
  // built by the src/db/sqlx.ts helpers, which dispatch on the handle's
  // engineDialect brand. SQLite-only modules (schema, migrations, the sqlite
  // and actor adapters) and tests are exempt.
  {
    files: ['packages/engine/src/**/*.ts'],
    ignores: [
      'packages/engine/src/db/sqlx.ts',
      'packages/engine/src/db/schema*.ts',
      'packages/engine/src/db/migrations/**',
      'packages/engine/src/adapters/sqlite/**',
      'packages/engine/src/adapters/sqlite-*.ts',
      'packages/engine/src/adapters/actor/**',
      'packages/engine/src/**/__tests__/**',
      'packages/engine/src/**/*.test.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
      {
        selector: 'TemplateElement[value.raw=/\\bunixepoch\\b/]',
        message: 'SQLite-only SQL `unixepoch` in a template literal: use sqlx.now / sqlx.epochOf from src/db/sqlx.ts.',
      },
      {
        selector: 'TemplateElement[value.raw=/\\bjson_extract\\b/]',
        message: 'SQLite-only SQL `json_extract` in a template literal: use sqlx.jsonGet / sqlx.jsonGetNum from src/db/sqlx.ts.',
      },
      {
        selector: 'TemplateElement[value.raw=/\\bjson_each\\b/]',
        message: 'SQLite-only SQL `json_each` in a template literal: use sqlx.jsonEach / sqlx.inJsonArray from src/db/sqlx.ts.',
      },
      {
        selector: 'TemplateElement[value.raw=/\\bjson_set\\b/]',
        message: 'SQLite-only SQL `json_set` in a template literal: use sqlx.jsonSet from src/db/sqlx.ts.',
      },
      {
        selector: 'TemplateElement[value.raw=/\\bjson_insert\\b/]',
        message: 'SQLite-only SQL `json_insert` in a template literal: use sqlx.jsonAppend from src/db/sqlx.ts.',
      },
      {
        selector: 'TemplateElement[value.raw=/\\bjson_patch\\b/]',
        message: 'SQLite-only SQL `json_patch` in a template literal: use sqlx.jsonMerge from src/db/sqlx.ts.',
      },
      {
        selector: 'TemplateElement[value.raw=/\\bjson_object\\b/]',
        message: 'SQLite-only SQL `json_object` in a template literal: use sqlx.jsonObject from src/db/sqlx.ts.',
      },
      {
        selector: 'TemplateElement[value.raw=/\\bjson_group_array\\b/]',
        message: 'SQLite-only SQL `json_group_array` in a template literal: use sqlx.jsonAgg from src/db/sqlx.ts.',
      },
      {
        selector: 'TemplateElement[value.raw=/\\bjson_valid\\b/]',
        message: 'SQLite-only SQL `json_valid` in a template literal: use sqlx.jsonValid from src/db/sqlx.ts.',
      },
      {
        selector: 'TemplateElement[value.raw=/\\bjson_type\\b/]',
        message: 'SQLite-only SQL `json_type` in a template literal: use sqlx.jsonType from src/db/sqlx.ts.',
      },
      {
        selector: 'TemplateElement[value.raw=/\\browid\\b/]',
        message: 'SQLite-only SQL `rowid` in a template literal: use sqlx.rowid from src/db/sqlx.ts.',
      },
      {
        selector: 'TemplateElement[value.raw=/\\bsqlite_master\\b/]',
        message: 'SQLite-only SQL `sqlite_master` in a template literal: use sqlx.indexExists from src/db/sqlx.ts.',
      },
      {
        selector: 'TemplateElement[value.raw=/\\bINDEXED BY\\b/]',
        message: 'SQLite-only SQL `INDEXED BY` in a template literal: use sqlx.indexedBy from src/db/sqlx.ts.',
      },
      {
        selector: 'TemplateElement[value.raw=/\\bNOT INDEXED\\b/]',
        message: 'SQLite-only SQL `NOT INDEXED` in a template literal: use sqlx.notIndexed from src/db/sqlx.ts.',
      },
      {
        selector: 'TemplateElement[value.raw=/\\bGLOB\\b/]',
        message: 'SQLite-only SQL `GLOB` in a template literal: use sqlx.startsWith from src/db/sqlx.ts.',
      },
      {
        selector: 'TemplateElement[value.raw=/\\binstr\\(/]',
        message: 'SQLite-only SQL `instr(` in a template literal: use sqlx.contains from src/db/sqlx.ts.',
      },
      {
        selector: 'TemplateElement[value.raw=/\\bstrftime\\b/]',
        message: 'SQLite-only SQL `strftime` in a template literal: use sqlx.isoFromEpoch from src/db/sqlx.ts.',
      },
      {
        selector: 'TemplateElement[value.raw=/\\bdatetime\\(/]',
        message: 'SQLite-only SQL `datetime(` in a template literal: use sqlx.isoFromEpoch from src/db/sqlx.ts.',
      },
      {
        selector: 'TemplateElement[value.raw=/\\btypeof\\(/]',
        message: 'SQLite-only SQL `typeof(` in a template literal: use sqlx.isInteger / sqlx.isNotInteger from src/db/sqlx.ts.',
      },
      ],
    },
  },
  {
    ignores: [
      'dist/',
      'node_modules/',
      '*.js',
      '*.cjs',
      '*.mjs',
      'coverage/',
      'site/',
      '**/__tests__/',
    ],
  },
);
