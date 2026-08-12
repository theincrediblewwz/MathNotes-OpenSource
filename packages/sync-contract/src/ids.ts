import { v5 as uuidv5, v7 as uuidv7, validate as validateUuid, version as uuidVersion } from "uuid";

export type EntityId = string;

export function createEntityId(): EntityId {
  return uuidv7();
}

export function createDeterministicEntityId(namespaceId: string, legacyIdentity: string): EntityId {
  return uuidv5(legacyIdentity, namespaceId);
}

export function isUuidV7(value: string): boolean {
  return validateUuid(value) && uuidVersion(value) === 7;
}

export function isUuidV5(value: string): boolean {
  return validateUuid(value) && uuidVersion(value) === 5;
}
