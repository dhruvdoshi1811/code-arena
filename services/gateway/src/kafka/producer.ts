import confluent from '@confluentinc/kafka-javascript';
import { config } from '../config.js';
import type { SubmissionEvent } from '../domain.js';

// The package is CommonJS and exposes two APIs side by side: the node-rdkafka-style
// surface at the top level, and a KafkaJS-compatible one under `KafkaJS`. From ESM only
// the default import is reliable, so the namespace is destructured here rather than
// reached for with a named import that would resolve to undefined at runtime.
const { KafkaJS } = confluent;

type Producer = ReturnType<InstanceType<typeof KafkaJS.Kafka>['producer']>;

let producer: Producer | null = null;

/**
 * Connect the producer once, at boot.
 *
 * `idempotent` is on, which pins acks to all and makes librdkafka deduplicate on
 * retry. Without it a network blip between "broker wrote the record" and "producer saw
 * the ack" produces a duplicate on retry — and a duplicated submission event means the
 * same code executed twice in Phase D, in two separate Kubernetes Jobs.
 */
export async function connectKafka(): Promise<void> {
  if (producer) return;

  const kafka = new KafkaJS.Kafka({
    kafkaJS: {
      brokers: config.kafkaBrokers,
      clientId: config.kafkaClientId,
      logLevel: config.isTest ? KafkaJS.logLevel.NOTHING : KafkaJS.logLevel.WARN,
    },
  });

  const created = kafka.producer({
    kafkaJS: { idempotent: true },
    // librdkafka-level knob: the total budget for delivering a record, retries
    // included. Bounded so an unreachable broker surfaces as a failed request the
    // caller can retry, rather than a POST that hangs until the client gives up.
    'message.timeout.ms': 10_000,
  });

  await created.connect();
  producer = created;
}

export async function disconnectKafka(): Promise<void> {
  const current = producer;
  producer = null;
  if (current) await current.disconnect();
}

/**
 * Publish one submission and wait for the broker to acknowledge it.
 *
 * Keyed by `sessionId` so every submission for a session lands on the same partition
 * and is therefore consumed in the order it was made. Keying randomly would spread one
 * session's runs across partitions, where nothing orders them relative to each other.
 */
export async function publishSubmission(event: SubmissionEvent): Promise<void> {
  if (!producer) {
    throw new Error('Kafka producer is not connected — call connectKafka() at boot');
  }

  await producer.send({
    topic: config.kafkaSubmissionsTopic,
    messages: [{ key: event.sessionId, value: JSON.stringify(event) }],
  });
}

/** True once the producer has connected; used by the health endpoint. */
export function isKafkaConnected(): boolean {
  return producer !== null;
}
