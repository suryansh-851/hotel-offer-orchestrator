function parsePort(value: string, name: string) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be 1–65535`);
  return port;
}

const port = parsePort(process.env.PORT ?? '3000', 'PORT');

export const config = {
  port,
  // Demo only. Lets X-Mock-Outage simulate supplier outages. Off unless set to "true" or "1".
  enableMockFaults: ['true', '1'].includes((process.env.ENABLE_MOCK_FAULTS ?? '').toLowerCase()),
  workerHealthPort: process.env.WORKER_HEALTH_PORT === undefined
    ? undefined : parsePort(process.env.WORKER_HEALTH_PORT, 'WORKER_HEALTH_PORT'),
  temporalAddress: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  taskQueue: 'hotel-offers',
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  supplierBaseUrl: process.env.SUPPLIER_BASE_URL ?? `http://127.0.0.1:${port}`,
  snapshotTtlSeconds: 600
};
