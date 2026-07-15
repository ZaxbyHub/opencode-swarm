import readline from 'readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

export async function selectFromList(title, labels, values) {
  console.log('');
  console.log(`\x1b[36m${title}\x1b[0m`);
  console.log('-'.repeat(60));
  labels.forEach((label, i) => {
    console.log(`  [\x1b[33m${i + 1}\x1b[0m] ${label}`);
  });
  console.log('');

  while (true) {
    const input = await ask(`Please select (1-${labels.length}): `);
    const idx = parseInt(input) - 1;
    if (idx >= 0 && idx < labels.length) {
      return values[idx];
    }
    console.log('\x1b[33mPlease enter a valid number\x1b[0m');
  }
}

export function close() {
  rl.close();
}
