// OCR attempts audit table.
//
// PartitionKey = YYYYMMDD (UTC day bucket; eases retention/cleanup later).
// RowKey       = reverse-ts(now)_ulid.

import type { TableEntity } from '@azure/data-tables';
import { getTable } from './client.js';
import { dayBucket, timeRowKey } from './keys.js';

export type OcrAttemptInput = {
  fueling_id: string | null;
  pump_image_present: boolean;
  dashboard_image_present: boolean;
  model: string;
  prompt_version: string;
  parsed_json: string | null;
  raw_pump_response: string | null;
  raw_dashboard_response: string | null;
  error: string | null;
};

type OcrAttemptEntity = TableEntity<{
  fueling_id: string | null;
  pump_image_present: boolean;
  dashboard_image_present: boolean;
  model: string;
  prompt_version: string;
  parsed_json: string | null;
  raw_pump_response: string | null;
  raw_dashboard_response: string | null;
  error: string | null;
  created_at: string;
}>;

export async function createOcrAttempt(input: OcrAttemptInput): Promise<void> {
  const t = await getTable('ocrAttempts');
  const now = new Date();
  const entity: OcrAttemptEntity = {
    partitionKey: dayBucket(now),
    rowKey: timeRowKey(now),
    fueling_id: input.fueling_id,
    pump_image_present: input.pump_image_present,
    dashboard_image_present: input.dashboard_image_present,
    model: input.model,
    prompt_version: input.prompt_version,
    parsed_json: input.parsed_json,
    raw_pump_response: input.raw_pump_response,
    raw_dashboard_response: input.raw_dashboard_response,
    error: input.error,
    created_at: now.toISOString(),
  };
  await t.createEntity(entity);
}
