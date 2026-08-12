import { validateCoreEnvironment, type CoreEnvironment } from "./environment";

export type MathNotesCoreState = "created" | "starting" | "running" | "stopping" | "stopped";

export interface CoreServiceContext {
  readonly environment: CoreEnvironment;
}

export interface CoreService {
  readonly name: string;
  start(context: CoreServiceContext): Promise<void> | void;
  stop(): Promise<void> | void;
}

export interface MathNotesCore {
  readonly environment: CoreEnvironment;
  readonly state: MathNotesCoreState;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateMathNotesCoreOptions {
  readonly services?: readonly CoreService[];
}

export function createMathNotesCore(
  environment: CoreEnvironment,
  options: CreateMathNotesCoreOptions = {}
): MathNotesCore {
  validateCoreEnvironment(environment);
  const services = [...(options.services ?? [])];
  ensureUniqueServiceNames(services);
  let state: MathNotesCoreState = "created";
  let operation: Promise<void> | undefined;
  const startedServices: CoreService[] = [];

  return {
    environment,
    get state() {
      return state;
    },
    async start() {
      if (state === "running") return;
      if (operation) return operation;
      if (state === "stopped") throw new Error("A stopped MathNotesCore cannot be restarted");

      state = "starting";
      operation = startServices();
      try {
        await operation;
        state = "running";
        environment.logger.info("MathNotes Core started", { serviceCount: startedServices.length });
      } catch (startError) {
        let rollbackError: unknown;
        try {
          await stopStartedServices();
        } catch (error) {
          rollbackError = error;
        }
        state = "stopped";
        environment.logger.error("MathNotes Core failed to start", {
          error: errorMessage(startError),
          rollbackError: rollbackError ? errorMessage(rollbackError) : undefined
        });
        if (rollbackError) {
          throw new AggregateError(
            [normalizeError(startError), normalizeError(rollbackError)],
            "MathNotes Core failed to start and roll back"
          );
        }
        throw startError;
      } finally {
        operation = undefined;
      }
    },
    async stop() {
      if (operation) await operation;
      if (state === "created") {
        state = "stopped";
        return;
      }
      if (state === "stopped") return;

      state = "stopping";
      operation = stopStartedServices();
      try {
        await operation;
        state = "stopped";
        environment.logger.info("MathNotes Core stopped");
      } finally {
        operation = undefined;
      }
    }
  };

  async function startServices() {
    for (const service of services) {
      await service.start({ environment });
      startedServices.push(service);
      environment.logger.debug("Core service started", { service: service.name });
    }
  }

  async function stopStartedServices() {
    const errors: Error[] = [];
    for (const service of startedServices.splice(0).reverse()) {
      try {
        await service.stop();
        environment.logger.debug("Core service stopped", { service: service.name });
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "One or more Core services failed to stop");
  }
}

function ensureUniqueServiceNames(services: readonly CoreService[]) {
  const names = new Set<string>();
  for (const service of services) {
    if (!service.name.trim()) throw new Error("CoreService.name is required");
    if (names.has(service.name)) throw new Error(`Duplicate CoreService name: ${service.name}`);
    names.add(service.name);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
