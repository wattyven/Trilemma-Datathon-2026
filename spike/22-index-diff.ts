// Compares two hires-index.json files (ignoring the build date) and prints a markdown summary of
// what's new: point-cloud projects, and tiles per survey year for the point clouds and LidarBC.
// Used by .github/workflows/refresh-index.yml.
//   node spike/22-index-diff.ts <old.json> <new.json>
// Exit code: 0 the same, 10 different (summary printed), anything else an error.
import { readFileSync } from 'node:fs';
import { diffIndex } from './index-diff.ts';

const [oldPath, newPath] = process.argv.slice(2);
if (!oldPath || !newPath) {
  console.error('usage: node spike/22-index-diff.ts <old.json> <new.json>');
  process.exit(2);
}
const lines = diffIndex(JSON.parse(readFileSync(oldPath, 'utf8')), JSON.parse(readFileSync(newPath, 'utf8')));
if (lines.length) {
  console.log(['New high-resolution LiDAR is listed for Metro Vancouver:', '', ...lines].join('\n'));
  process.exit(10);
}
