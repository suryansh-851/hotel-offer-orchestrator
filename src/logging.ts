import { DefaultLogger, type LogEntry } from '@temporalio/worker';

/**
 * Formats a Temporal SDK log entry as one JSON line, `{ event, level, ...fields }`.
 * That is the shape the API already logs, so `docker compose logs` reads as one stream.
 */
export function formatLogEntry({ message, level, meta }: LogEntry): string {
  // The task token is an opaque base64 blob that only adds noise to a log line.
  const { taskToken: _taskToken, ...fields } = meta ?? {};
  return JSON.stringify({ event: message, level: level.toLowerCase(), ...fields }, (_key, value: unknown) => {
    if (typeof value === 'bigint') return value.toString();
    return value instanceof Error ? { name: value.name, message: value.message } : value;
  });
}

/** Writes warnings and errors to stderr and everything else to stdout, one JSON line each. */
export function createJsonLogger(
  write: (stream: 'stdout' | 'stderr', line: string) => void = (stream, line) => { process[stream].write(`${line}\n`); }
) {
  return new DefaultLogger('INFO', entry => {
    write(entry.level === 'WARN' || entry.level === 'ERROR' ? 'stderr' : 'stdout', formatLogEntry(entry));
  });
}
