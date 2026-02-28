import confluent from '@confluentinc/kafka-javascript';
import { config } from '../config.js';
import type { SubmissionEvent } from '../domain.js';

// The package is CommonJS and exposes two APIs side by side: the node-rdkafka-style surface at.
const { KafkaJS } = confluent;

type Producer = ReturnType<InstanceType<typeof KafkaJS.Kafka>['producer']>;

let producer: Producer | null = null;

/** Connect the producer once, at boot. */
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
    // librdkafka-level knob: the total budget for delivering a record, retries included.
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

/** Publish one submission and wait for the broker to acknowledge it. */
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
