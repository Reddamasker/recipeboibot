import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const digest = createHash('sha256');

function addDirectory(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) addDirectory(path);
    else if (entry.isFile()) digest.update(path).update('\0').update(readFileSync(path));
    else throw new Error(`Unexpected release file type at ${path}`);
  }
}

addDirectory('src');
addDirectory('public');
console.log(digest.digest('hex'));
