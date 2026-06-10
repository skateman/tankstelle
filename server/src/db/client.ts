// Azure Table Storage client factory.
//
// Supports two auth modes (selected automatically by env.ts):
//   * connection_string  → local dev (Azurite) or any environment with an
//                          AZURE_STORAGE_CONNECTION_STRING / AzureWebJobsStorage.
//   * managed_identity   → production inside an Azure Function / App Service.
//                          Requires AZURE_STORAGE_TABLE_URI (or the Functions
//                          alias AzureWebJobsStorage__tableServiceUri) plus an
//                          identity (system-assigned, or user-assigned via
//                          AZURE_CLIENT_ID) with the "Storage Table Data
//                          Contributor" role on the storage account.
//
// One TableServiceClient is created lazily and reused. Per-table TableClients
// are cached. Each table is created-if-not-exists on first request, so the
// rest of the code can assume the table is ready.

import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { TableClient, TableServiceClient } from '@azure/data-tables';
import { env, storageMode } from '../env.js';

const TABLE_NAMES = ['vehicles', 'fuelings', 'ocrAttempts'] as const;
export type TableName = (typeof TABLE_NAMES)[number];

let serviceClient: TableServiceClient | null = null;
let credential: TokenCredential | null = null;
const tableClients = new Map<TableName, TableClient>();
const readyTables = new Set<TableName>();

function getCredential(): TokenCredential {
  if (!credential) {
    // managedIdentityClientId is harmless when undefined; with it set,
    // DefaultAzureCredential prefers that user-assigned identity.
    credential = new DefaultAzureCredential(
      env.AZURE_CLIENT_ID ? { managedIdentityClientId: env.AZURE_CLIENT_ID } : {},
    );
  }
  return credential;
}

function buildServiceClient(): TableServiceClient {
  if (storageMode === 'connection_string') {
    if (!env.STORAGE_CONNECTION_STRING) {
      throw new Error('storage configured as connection_string but STORAGE_CONNECTION_STRING is empty');
    }
    return TableServiceClient.fromConnectionString(env.STORAGE_CONNECTION_STRING, {
      allowInsecureConnection: env.isAzuriteDev,
    });
  }
  if (!env.STORAGE_TABLE_URI) {
    throw new Error(
      'storage configured as managed_identity but STORAGE_TABLE_URI / AzureWebJobsStorage__tableServiceUri is unset',
    );
  }
  return new TableServiceClient(env.STORAGE_TABLE_URI, getCredential());
}

function buildTableClient(name: TableName): TableClient {
  if (storageMode === 'connection_string') {
    return TableClient.fromConnectionString(env.STORAGE_CONNECTION_STRING!, name, {
      allowInsecureConnection: env.isAzuriteDev,
    });
  }
  return new TableClient(env.STORAGE_TABLE_URI!, name, getCredential());
}

function getServiceClient(): TableServiceClient {
  if (!serviceClient) serviceClient = buildServiceClient();
  return serviceClient;
}

async function ensureTable(name: TableName): Promise<void> {
  if (readyTables.has(name)) return;
  try {
    await getServiceClient().createTable(name);
  } catch (e) {
    // 409 TableAlreadyExists is fine; rethrow anything else.
    const status = (e as { statusCode?: number }).statusCode;
    if (status !== 409) throw e;
  }
  readyTables.add(name);
}

export async function getTable(name: TableName): Promise<TableClient> {
  let client = tableClients.get(name);
  if (!client) {
    client = buildTableClient(name);
    tableClients.set(name, client);
  }
  await ensureTable(name);
  return client;
}
