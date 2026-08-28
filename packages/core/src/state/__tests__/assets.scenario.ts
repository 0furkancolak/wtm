import { SQLiteStateStore } from '../sqlite-store';

let readCount = 0;
let migrationFailed = false;
try {
  new SQLiteStateStore(':memory:', {
    migrationAssets: {
      readMigrations() {
        readCount += 1;
        return ['this injected migration must fail'];
      },
    },
  });
} catch {
  migrationFailed = true;
}

process.stdout.write(JSON.stringify({ migrationFailed, readCount }));
