import type { CoreEnvironment } from "./environment";
import {
  createMathNotesCore,
  type CreateMathNotesCoreOptions,
  type MathNotesCore
} from "./mathNotesCore";

/** Starts the shared Core without a window system; the host owns shutdown. */
export async function startMathNotesCoreHeadless(
  environment: CoreEnvironment,
  options: CreateMathNotesCoreOptions = {}
): Promise<MathNotesCore> {
  const core = createMathNotesCore(environment, options);
  await core.start();
  return core;
}
