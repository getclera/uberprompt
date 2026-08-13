import { OpenTelemetry } from "@ai-sdk/otel";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { registerTelemetry } from "ai";
import { closeDb } from "@uberprompt/sdk";
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
      enrichSpan: ({ runtimeContext }) => promptAttributes(runtimeContext),
    }),
  );

  return {
    forceFlush: () => provider.forceFlush(),
    shutdown: async () => {
      await provider.shutdown();
      await closeDb();
      registered = undefined;
    },
  };
}
