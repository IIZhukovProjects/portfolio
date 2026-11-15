import {cp, rm} from 'node:fs/promises';

const output = new URL('../dist/', import.meta.url);
await rm(output, {force: true, recursive: true});
await cp(new URL('./', import.meta.url), output, {
  recursive: true,
  filter: path => !path.endsWith('/build.mjs')
});
await cp(new URL('../public/', import.meta.url), output, {recursive: true});
