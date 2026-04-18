import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@ai-herders/shared/schema";
import { env } from "./env";

export const pool = new Pool({ connectionString: env.DATABASE_URL });

export const db = drizzle({ client: pool, schema });

export type Database = typeof db;
