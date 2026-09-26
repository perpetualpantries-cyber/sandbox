// Vercel serverless entry point. Express apps are callable as (req, res) => {...},
// so exporting the app instance directly works as a Vercel Node function handler.
import { createApp } from '../src/app.js';

export default createApp();
