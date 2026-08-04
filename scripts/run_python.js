import { spawn } from 'node:child_process';

const [, , script, ...args] = process.argv;

if (!script) {
  console.error('Usage: node scripts/run_python.js <script.py> [...args]');
  process.exit(2);
}

const pythonBin = String(process.env.PYTHON_BIN || '').trim()
  || (process.platform === 'win32' ? 'python' : 'python3');
const child = spawn(pythonBin, [script, ...args], {
  stdio: 'inherit',
  env: process.env,
});

child.on('error', (error) => {
  console.error(`Unable to start ${pythonBin}: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`${pythonBin} stopped by signal ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
