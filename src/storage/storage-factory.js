import { createInMemoryStorage } from "./in-memory-storage.js";
import { createPostgresStorage } from "./postgres-storage.js";

export function createStorage(config) {
  if (config.storageProvider === "postgres") {
    return createPostgresStorage({ connectionString: config.databaseUrl });
  }
  return createInMemoryStorage();
}
