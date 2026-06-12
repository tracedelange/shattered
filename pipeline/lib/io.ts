import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import yaml from 'js-yaml';

export const REPO_ROOT = process.cwd();
export const WORLD_DIR = join(REPO_ROOT, 'world');
export const PIPELINE_DIR = join(WORLD_DIR, 'pipeline');
export const LORE_FILE = join(WORLD_DIR, 'lore', 'bible.yaml');
export const SAGAS_FILE = join(WORLD_DIR, 'lore', 'sagas.yaml');
export const TILESETS_DIR = join(WORLD_DIR, 'tilesets');
export const OPPS_FILE = join(PIPELINE_DIR, 'opportunities.yaml');
export const HISTORY_FILE = join(PIPELINE_DIR, 'history.yaml');
export const METRICS_FILE = join(PIPELINE_DIR, 'world_metrics.yaml');

export function readYaml<T>(path: string): T {
  return yaml.load(readFileSync(path, 'utf8')) as T;
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

export function writeYaml(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  // lineWidth: -1 keeps long lines (rationales, descriptions) on one line.
  const body = yaml.dump(value, { lineWidth: -1, noRefs: true });
  writeFileSync(path, body, 'utf8');
}

export function writeText(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

export function appendText(path: string, body: string): void {
  const prev = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writeText(path, prev + body);
}

export function listYamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (extname(full) === '.yaml') out.push(full);
  }
  return out.sort();
}

export function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (extname(full) === '.json') out.push(full);
  }
  return out.sort();
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}
