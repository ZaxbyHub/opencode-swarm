import readline from 'readline';

// The readline interface is created lazily on first prompt rather than at
// import time. Commands that never prompt (`list`, `help`) therefore never
// open stdin and exit cleanly instead of hanging on an open TTY.
let rl = null;
let ioInput = process.stdin;
let ioOutput = process.stdout;

// Allow tests to drive the interactive flow with scripted streams.
export function setIo(input, output) {
  ioInput = input;
  ioOutput = output;
}

function getRl() {
  if (!rl) {
    rl = readline.createInterface({ input: ioInput, output: ioOutput });
  }
  return rl;
}

export function ask(prompt) {
  return new Promise((resolve) => getRl().question(prompt, resolve));
}

const QUIT_LABEL = '[quit/exit]';
export const QUIT_VALUE = '__quit__';

export async function selectFromList(title, labels, values, allowQuit = true) {
  const shownLabels = allowQuit ? [...labels, QUIT_LABEL] : labels;
  const shownValues = allowQuit ? [...values, QUIT_VALUE] : values;

  console.log('');
  console.log(`\x1b[36m${title}\x1b[0m`);
  console.log('-'.repeat(60));
  shownLabels.forEach((label, i) => {
    console.log(`  [\x1b[33m${i + 1}\x1b[0m] ${label}`);
  });
  console.log('');

  while (true) {
    const input = await ask(`Please select (1-${shownLabels.length}): `);
    const idx = parseInt(input, 10) - 1;
    if (idx >= 0 && idx < shownLabels.length) {
      return shownValues[idx];
    }
    console.log('\x1b[33mPlease enter a valid number\x1b[0m');
  }
}

export function close() {
  if (rl) {
    rl.close();
    rl = null;
  }
}
