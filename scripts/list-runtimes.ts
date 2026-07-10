/**
 * Reference shape for the future `agent-relay workflow runtimes --list` CLI.
 *
 * This script reads the shared defaultRegistry. Runtimes only appear after
 * their registration modules are imported, so defaults are opted in below.
 */
import '../packages/core/src/runtime/register-defaults.js';
import { defaultRegistry, type RuntimeDescriptor } from '../packages/core/src/runtime/index.js';

const JSON_FLAG = '--json';
const FOOTER =
  'Runtimes are registered via RuntimeRegistry.register(). See packages/core/src/runtime/registry.ts';

const runtimes = defaultRegistry.list();

if (process.argv.includes(JSON_FLAG)) {
  console.log(JSON.stringify({ runtimes }, null, 2));
} else {
  printTable(runtimes);
  console.log('');
  console.log(FOOTER);
}

function printTable(descriptors: RuntimeDescriptor[]): void {
  const rows = descriptors.map((descriptor) => ({
    id: descriptor.id,
    name: descriptor.displayName,
    status: descriptor.status,
    isolation: descriptor.capabilities.isolation,
    snapshots: formatBoolean(descriptor.capabilities.snapshots),
    pty: formatBoolean(descriptor.capabilities.pty),
    description: descriptor.description,
  }));

  const headers = {
    id: 'ID',
    name: 'NAME',
    status: 'STATUS',
    isolation: 'ISOLATION',
    snapshots: 'SNAPSHOTS',
    pty: 'PTY',
    description: 'DESCRIPTION',
  };

  const widths = {
    id: columnWidth(headers.id, rows.map((row) => row.id)),
    name: columnWidth(headers.name, rows.map((row) => row.name)),
    status: columnWidth(headers.status, rows.map((row) => row.status)),
    isolation: columnWidth(headers.isolation, rows.map((row) => row.isolation)),
    snapshots: columnWidth(headers.snapshots, rows.map((row) => row.snapshots)),
    pty: columnWidth(headers.pty, rows.map((row) => row.pty)),
  };

  console.log(
    [
      pad(headers.id, widths.id),
      pad(headers.name, widths.name),
      pad(headers.status, widths.status),
      pad(headers.isolation, widths.isolation),
      pad(headers.snapshots, widths.snapshots),
      pad(headers.pty, widths.pty),
      headers.description,
    ].join('  '),
  );

  for (const row of rows) {
    console.log(
      [
        pad(row.id, widths.id),
        pad(row.name, widths.name),
        pad(row.status, widths.status),
        pad(row.isolation, widths.isolation),
        pad(row.snapshots, widths.snapshots),
        pad(row.pty, widths.pty),
        row.description,
      ].join('  '),
    );
  }
}

function columnWidth(header: string, values: string[]): number {
  return Math.max(header.length, ...values.map((value) => value.length));
}

function pad(value: string, width: number): string {
  return value.padEnd(width, ' ');
}

function formatBoolean(value: boolean): string {
  return value ? 'yes' : 'no';
}
