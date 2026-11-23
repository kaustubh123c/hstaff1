// Vercel catch-all API function. The existing Express app owns /api/* routes.
import { createApp } from '../server/src/index.js';

const app = createApp();
export default app;
