import { WorkflowFailedError, isGrpcDeadlineError } from '@temporalio/client';
import { ApplicationFailure, TimeoutFailure } from '@temporalio/common';
import type { Offer, Search, Supplier } from './domain';

/** How long the API waits for Temporal to accept a workflow. Past this the search fails fast with 503. */
export const startTimeoutMs = 3000;
/** The workflow's own limit, enforced by the Temporal server. */
export const workflowExecutionTimeoutMs = 30000;
/**
 * Extra time to read the result. It keeps the API's deadline just above the workflow limit,
 * so the workflow's own TimeoutFailure reaches us before our gRPC deadline does.
 */
export const resultGraceMs = 2000;

export interface SearchResult {
  offers: Offer[];
  unavailable: Supplier[];
}

/** The two Temporal calls a search makes. Deadlines are absolute epoch milliseconds. */
export interface SearchPorts<Handle> {
  start(search: Search, workflowId: string, deadline: number): Promise<Handle>;
  result(handle: Handle, deadline: number): Promise<SearchResult>;
}

/** A search failure that already knows its HTTP status and public error code. */
export class SearchError extends Error {
  constructor(readonly status: 503 | 504, readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** The catch-all: Temporal or orchestration could not serve the search right now. */
export const searchUnavailable = (cause: unknown) =>
  new SearchError(503, 'SEARCH_UNAVAILABLE', 'Hotel search is temporarily unavailable.', { cause });

/** Maps a failure that happened after the workflow started. */
function resultError(error: unknown): SearchError {
  const cause = error instanceof WorkflowFailedError ? error.cause : undefined;
  if (cause instanceof ApplicationFailure && cause.type === 'SuppliersUnavailable') {
    return new SearchError(503, 'SUPPLIERS_UNAVAILABLE', 'Both suppliers are unavailable.', { cause: error });
  }
  if (cause instanceof ApplicationFailure && cause.type === 'StorageUnavailable') {
    return new SearchError(503, 'STORAGE_UNAVAILABLE', 'Offer storage is unavailable.', { cause: error });
  }
  if (cause instanceof TimeoutFailure || isGrpcDeadlineError(error)) {
    return new SearchError(504, 'SEARCH_TIMEOUT', 'Hotel search timed out.', { cause: error });
  }
  return searchUnavailable(error);
}

/**
 * Starts the search workflow and waits for its result. Always rejects with a SearchError.
 *
 * Any failure to start, including a start deadline, is 503: Temporal never accepted the work.
 * Only a workflow that did start can time out (504).
 */
export async function runSearch<Handle>(
  ports: SearchPorts<Handle>, search: Search, workflowId: string, now: () => number = Date.now
): Promise<SearchResult> {
  let handle: Handle;
  try {
    handle = await ports.start(search, workflowId, now() + startTimeoutMs);
  } catch (error) {
    throw searchUnavailable(error);
  }
  try {
    return await ports.result(handle, now() + workflowExecutionTimeoutMs + resultGraceMs);
  } catch (error) {
    throw resultError(error);
  }
}
