import { createApp } from './app.js';
import { migrate } from './migrate.js';

const port = Number(process.env.PORT || 8080);
await migrate();
createApp().listen(port, () => console.log(`pp-backend listening on :${port}`));
