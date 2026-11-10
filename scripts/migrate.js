import { readConfig } from "../src/config/env.js";
import { createStorage } from "../src/storage/storage-factory.js";
import { INITIAL_MEMORIES, INITIAL_OWNER_PROFILE, INITIAL_PROJECTS } from "../src/identity/initial-context.js";
import {syntheticPreviewEnvironment,SYNTHETIC_SEED} from '../src/identity/synthetic-preview.js';

const preview = syntheticPreviewEnvironment(process.env);
const config = readConfig(preview.environment);
if (config.storageProvider !== "postgres") {
  throw new Error("Set DATABASE_URL (or POSTGRES_URL) to run durable storage migrations.");
}

const storage = createStorage(config);
await storage.initialize(preview.synthetic ? {...SYNTHETIC_SEED,syntheticGuard:true} : { owner: INITIAL_OWNER_PROFILE, projects: INITIAL_PROJECTS, memories: INITIAL_MEMORIES });
const health = await storage.health();
console.log(`Nova Brain storage migration complete (${health.provider}, ${health.status}).`);
