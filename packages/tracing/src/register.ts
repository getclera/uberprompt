import { OpenTelemetry } from "@ai-sdk/otel";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { registerTelemetry } from "ai";
import { promptAttributes } from "./binding";
import { MongoSpanExporter } from "./exporter";

export interface RegisterOptions {
  service?: string;
  flushIntervalMs?: number;
}

export interface Registration {
  shutdown: () => Promise<void>;
  forceFlush: () => Promise<void>;
}

let registered: string | undefined;

export function registerUberprompt(options: RegisterOptions = {}): Registration {
  const service = options.service ?? "uberprompt-app";

  // OpenTelemetry honors only the first global tracer provider per process. A second
  // registration is ignored silently, and every span from it disappears — so fail here
  // rather than let a caller believe a second service is being traced.
  if (registered !== undefined) {
    throw new Error(
      `registerUberprompt already called for service "${registered}"; call it once per process (attempted: "${service}")`,
    );
  }
  registered = service;

  const exporter = new MongoSpanExporter(service);

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": service }),
    spanProcessors: [
      new BatchSpanProcessor(exporter, { scheduledDelayMillis: options.flushIntervalMs ?? 1000 }),
    ],
  });
  provider.register();

  registerTelemetry(
    new OpenTelemetry({
      usage: true,
      providerMetadata: true,
      runtimeContext: true,
      enrichSpan: () => promptAttributes(),
    }),
  );

  // Spans buffered by the batch processor are lost if the process exits without a
  // flush, which is the normal way a demo app or the collector is stopped.
  const flushOnExit = (): void => {
    void provider.forceFlush();
  };
  process.once("SIGINT", flushOnExit);
  process.once("SIGTERM", flushOnExit);
  process.once("beforeExit", flushOnExit);

  return {
    forceFlush: () => provider.forceFlush(),
    // The Mongo client is shared process-wide via the SDK, so closing it here would
    // break any other consumer (the agent, a CLI command) still running.
    shutdown: async () => {
      process.off("SIGINT", flushOnExit);
      process.off("SIGTERM", flushOnExit);
      process.off("beforeExit", flushOnExit);
      await provider.shutdown();
      registered = undefined;
    },
  };
}
