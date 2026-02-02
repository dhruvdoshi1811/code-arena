import { randomUUID } from 'node:crypto';
import confluent from '@confluentinc/kafka-javascript';
import { config } from '../src/config.js';
import type { SubmissionEvent } from '../src/domain.js';

const { KafkaJS } = confluent;

/**
 * Drain the submissions topic and return the events matching `wantedIds`.
 *
 * Reads from the beginning under a throwaway consumer group, then filters. The topic
 * accumulates across runs, so identifying this run's records by id is what keeps the
 * assertion meaningful — a count alone would pass on leftovers from a previous run.
 */
export async function collectSubmissionEvents(
  wantedIds: Set<string>,
  timeoutMs = 30_000,
): Promise<Map<string, SubmissionEvent>> {
  const kafka = new KafkaJS.Kafka({
    kafkaJS: {
      brokers: config.kafkaBrokers,
      clientId: `test-collector-${randomUUID().slice(0, 8)}`,
      logLevel: KafkaJS.logLevel.NOTHING,
    },
  });

  const consumer = kafka.consumer({
    kafkaJS: {
      // A fresh group every call, so this never inherits committed offsets from a
      // previous run and every record on the topic is visible.
      groupId: `test-collector-${randomUUID()}`,
      fromBeginning: true,
    },
  });

  const found = new Map<string, SubmissionEvent>();

  await consumer.connect();
  await consumer.subscribe({ topics: [config.kafkaSubmissionsTopic] });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `timed out after ${timeoutMs}ms with ${found.size}/${wantedIds.size} events collected`,
          ),
        );
      }, timeoutMs);

      const finish = () => {
        clearTimeout(timer);
        resolve();
      };

      void consumer
        .run({
          eachMessage: async ({ message }) => {
            if (!message.value) return;
            try {
              const event = JSON.parse(message.value.toString()) as SubmissionEvent;
              if (wantedIds.has(event.submissionId)) {
                found.set(event.submissionId, event);
                if (found.size === wantedIds.size) finish();
              }
            } catch {
              // Not one of ours, or not JSON. Ignore.
            }
          },
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  } finally {
    await consumer.disconnect();
  }

  return found;
}

/** The partition a keyed record landed on, to prove same-session ordering guarantees. */
export async function partitionCountForTopic(): Promise<number> {
  const kafka = new KafkaJS.Kafka({
    kafkaJS: {
      brokers: config.kafkaBrokers,
      clientId: `test-admin-${randomUUID().slice(0, 8)}`,
      logLevel: KafkaJS.logLevel.NOTHING,
    },
  });

  const admin = kafka.admin();
  await admin.connect();
  try {
    // This client returns the topic list directly, unlike KafkaJS which wraps it in
    // `{ topics: [...] }` — one of the places the compatibility layer is not identical.
    const topics = await admin.fetchTopicMetadata({ topics: [config.kafkaSubmissionsTopic] });
    return topics[0]?.partitions.length ?? 0;
  } finally {
    await admin.disconnect();
  }
}
