#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { initializeProject, ProjectError } from '../services/project.ts';
try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'reasoning-effort': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'mat init <项目根> --name <名称> --provider <已有provider> --model <已有model> [--reasoning-effort <effort>]',
    );
  } else {
    if (positionals.length !== 2 || positionals[0] !== 'init')
      throw new ProjectError(
        'INVALID_COMMAND',
        '用法：mat init <项目根> --name <名称> --provider <provider> --model <model>',
      );
    const supervisor = {
      provider: values.provider ?? '',
      model: values.model ?? '',
      ...(values['reasoning-effort'] === undefined
        ? {}
        : { reasoningEffort: values['reasoning-effort'] }),
    };
    console.log(
      JSON.stringify(
        initializeProject({ root: positionals[1]!, name: values.name ?? '', supervisor }),
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(
    JSON.stringify({
      code: error instanceof ProjectError ? error.code : 'INIT_FAILED',
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
}
