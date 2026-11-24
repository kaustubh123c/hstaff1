
import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import { pool } from './db-postgres.js';
import { createAdminAccountPostgres } from './admin-provision-postgres.js';

function question(prompt) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  return new Promise(resolve => {
    rl.question(prompt, value => {
      rl.close();
      resolve(value.trim());
    });
  });
}

function hiddenQuestion(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Run this command in a real terminal.');
  }

  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = '';
    let finished = false;

    const finish = (error) => {
      if (finished) return;
      finished = true;
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdout.write('\n');

      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') {
          finish(new Error('Admin creation cancelled.'));
          return;
        }

        if (char === '\r' || char === '\n') {
          finish();
          return;
        }

        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }

        if (char >= ' ' && char <= '~') {
          value += char;
        }
      }
    };

    stdin.on('data', onData);
  });
}

try {
  console.log('Create your initial H-Staff administrator account.');

  const name = await question('Admin name: ');
  const email = await question('Admin email: ');
  const password = await hiddenQuestion(
    'Admin password (12-100 characters): '
  );

  const id = await createAdminAccountPostgres(
    { name, email, password },
    { source: 'private PostgreSQL provisioning command' }
  );

  console.log(`Admin account created successfully (user id: ${id}).`);
  console.log('Use your email and password on the Admin Sign In page.');
} catch (error) {
  console.error('Admin creation failed:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
