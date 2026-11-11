import { createApp } from './app.js';
try {
  const { app, db } = createApp({ adminPassword: process.env.ADMIN_PASSWORD, databasePath: process.env.DATABASE_PATH || './data/quiz.sqlite', secureCookie: process.env.COOKIE_SECURE === 'true', trustProxy: process.env.TRUST_PROXY === '1' });
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Quiz Exam запущен на порту ${port}`));
  const stop = () => server.close(() => { db.close(); process.exit(0); });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
