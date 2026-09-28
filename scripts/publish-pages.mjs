import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'out');
const index = join(tmpdir(), `pristine-pages-${randomUUID()}.index`);
const domainFile = join(root, '.github', 'pages-domain');
const domain = (process.env.CUSTOM_DOMAIN || (existsSync(domainFile) ? readFileSync(domainFile, 'utf8') : '')).trim();

function git(args, env = process.env) {
  return execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] }).trim();
}

try {
  execFileSync(process.execPath, [join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], {
    cwd: root,
    env: { ...process.env, GITHUB_PAGES: domain ? '0' : '1' },
    stdio: 'inherit',
  });
  writeFileSync(join(output, '.nojekyll'), '');
  if (domain) writeFileSync(join(output, 'CNAME'), `${domain}\n`);

  const branchExists = git(['ls-remote', '--heads', 'origin', 'gh-pages']);
  if (branchExists) git(['fetch', '--no-tags', 'origin', 'gh-pages']);
  const current = branchExists ? git(['rev-parse', 'FETCH_HEAD']) : '';
  const publishEnv = {
    ...process.env,
    GIT_DIR: join(root, '.git'),
    GIT_WORK_TREE: output,
    GIT_INDEX_FILE: index,
  };
  git(['add', '--all', '--force'], publishEnv);
  const tree = git(['write-tree'], publishEnv);
  const args = ['commit-tree', tree, '-m', 'Publish Pristine static site'];
  if (current) args.push('-p', current);
  const commit = git(args, publishEnv);
  git(['push', 'origin', `${commit}:refs/heads/gh-pages`], publishEnv);
  process.stdout.write(`Published ${domain || 'awesomesauce711.github.io/pristine'}\n`);
} finally {
  rmSync(index, { force: true });
}
