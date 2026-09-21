import { config } from "dotenv";

// Load .env into process.env. This module is imported FIRST in the server
// (before harness/model.ts, which reads the API key at load time), because ES
// module imports are evaluated before top-level statements.
config();
