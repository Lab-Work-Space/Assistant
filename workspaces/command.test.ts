import { describe, expect, it } from 'vitest';
import { cmdFor, parseCommand } from './command.js';
import { WsError } from './errors.js';

const bad = (c: string) => {
  try {
    parseCommand(c);
  } catch (e) {
    expect(e, c).toBeInstanceOf(WsError);
    expect((e as WsError).code, c).toBe('E_CMD');
    return;
  }
  throw new Error(`accepted: ${JSON.stringify(c)}`);
};

describe('parseCommand (SA-1 5.3): every allowed form', () => {
  it('npm ci / test / run / tsc / node / install', () => {
    expect(parseCommand('npm ci')).toEqual({ verb: 'ci', specs: [] });
    expect(parseCommand('  npm   test ')).toEqual({ verb: 'test', specs: [] });
    expect(parseCommand('npm run build:prod')).toEqual({ verb: 'run', specs: [], script: 'build:prod' });
    expect(parseCommand('npx tsc')).toEqual({ verb: 'tsc', specs: [], noEmit: false });
    expect(parseCommand('npx tsc --noEmit')).toEqual({ verb: 'tsc', specs: [], noEmit: true });
    expect(parseCommand('node src/main.js')).toEqual({ verb: 'node', specs: [], rel: 'src/main.js' });
    expect(parseCommand('node a.mjs')).toEqual({ verb: 'node', specs: [], rel: 'a.mjs' });
    expect(parseCommand('npm install')).toEqual({ verb: 'install', specs: [] });
    expect(parseCommand('npm install is-number@7.0.0 @types/node@22.1.0 left-pad@1.3.0-beta.1')).toEqual({ verb: 'install', specs: ['is-number@7.0.0', '@types/node@22.1.0', 'left-pad@1.3.0-beta.1'] });
  });
  it('up to 10 specs', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `p${i}@1.0.0`);
    expect(parseCommand(`npm install ${ten.join(' ')}`).specs).toHaveLength(10);
    bad(`npm install ${[...ten, 'p10@1.0.0'].join(' ')}`);
  });
});

describe('parseCommand: refusals', () => {
  it.each([
    '', 'npm', 'npm i', 'npm install x', 'npm install x@1', 'npm install x@^1.0.0', 'npm install x@latest', 'npm install x@1.0.0 && ls', 'npm install x@1.0.0;ls',
    'npm install https://evil.test/x.tgz', 'npm install git+https://x/y.git', 'npm install github:a/b', 'npm install file:../x', 'npm install ./x@1.0.0', 'npm install ../x@1.0.0',
    'npm install npm:x@1.0.0', 'npm install a@1.0.0 --registry=http://x', 'npm install --save-dev x@1.0.0', 'npm ci --foreground-scripts', 'npm test -- --x', 'npm run', 'npm run a b',
    'npm run -x', 'npm run ../x', 'npm run a;b', 'npm run a$(id)', 'npx tsc --watch', 'npx tsc -p x', 'npx cowsay', 'npx tsc --noEmit extra', 'node', 'node x.js y', 'node x.ts', 'node x.sh', 'node /etc/x.js',
    'node ../x.js', 'node ./x.js', 'node a//b.js', 'node a\\b.js', 'node -e x.js', 'node x.js.txt', 'npm ci\nnpm test', 'npm\tci', 'npm ci | cat', 'npm ci > f', 'NPM CI', 'sh -c ls', 'npm install `id`@1.0.0',
    'npm install x@1.0.0 x@1.0.0 $HOME', 'npm install x@1.0.0 "y@1.0.0"', "npm install x@1.0.0 'y@1.0.0'", 'node a.js\0', 'npm run a'.padEnd(700, 'a'), 'npm exec x', 'npm publish', 'npm config set x y', 'npm install @a/b/c@1.0.0',
    'npm install @a@1.0.0', 'npm install A@1.0.0', 'npm run -- x', 'node .ws-tmp-x.js',
  ])('refuses %j', (c) => bad(c));
  it('refuses a script name outside the rule', () => {
    bad('npm run ' + 'a'.repeat(65));
    bad('npm run :a');
  });
});

describe('cmdFor', () => {
  it('maps each verb to its fixed command (the exact install flags of prep.sh)', () => {
    const flags = ['--ignore-scripts', '--no-audit', '--no-fund', '--registry', 'http://10.88.80.2:4873', '--userconfig', '/dev/null', '--globalconfig', '/nonexistent/npmrc', '--replace-registry-host=always'];
    expect(cmdFor(parseCommand('npm ci'))).toEqual(['/usr/local/bin/npm', 'ci', ...flags]);
    expect(cmdFor(parseCommand('npm install a@1.0.0'))).toEqual(['/usr/local/bin/npm', 'install', ...flags, 'a@1.0.0']);
    expect(cmdFor(parseCommand('npm test'))).toEqual(['/usr/local/bin/npm', 'test']);
    expect(cmdFor(parseCommand('npm run x'))).toEqual(['/usr/local/bin/npm', 'run', 'x']);
    expect(cmdFor(parseCommand('npx tsc'))).toEqual(['/usr/local/bin/node', '/work/node_modules/typescript/bin/tsc']);
    expect(cmdFor(parseCommand('npx tsc --noEmit'))).toEqual(['/usr/local/bin/node', '/work/node_modules/typescript/bin/tsc', '--noEmit']);
    expect(cmdFor(parseCommand('node a/b.js'))).toEqual(['/usr/local/bin/node', '/work/a/b.js']);
  });
});
