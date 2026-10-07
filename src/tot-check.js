import { createTotClient } from './tot-client.js';
import { japanDate } from './reconcile.js';

try {
  const client = createTotClient({ token: process.env.TOT_ACCESS_TOKEN });
  const result = await client.readDay(process.argv[2] || japanDate(new Date()));
  console.log(JSON.stringify({
    date: result.date, employeeCount: result.employees.length,
    punchRowCount: result.punches.length, scheduleRowCount: result.schedules.length,
    mode: 'read-only',
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
