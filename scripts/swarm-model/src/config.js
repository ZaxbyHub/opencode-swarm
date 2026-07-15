import fs from 'fs';
import path from 'path';

export function readSwarmConfig(filePath) {
  if (!fs.existsSync(filePath)) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify({ agents: {} }, null, 2), 'utf8');
    console.log(`Created: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse swarm config ${filePath}: ${err.message}`);
  }
}

export function writeSwarmConfig(config, filePath) {
  const backupPath = filePath + '.bak';
  if (fs.existsSync(filePath)) {
    let dest = backupPath;
    if (fs.existsSync(backupPath)) {
      // Full YYYYMMDDHHMMSS second-resolution stamp (matches README + the
      // PowerShell impl). The earlier slice(0,14) of the raw ISO string kept
      // the `-`/`T` separators and truncated to ~10-minute resolution, so
      // backups within the same 10-minute window collided and overwrote each
      // other; stripping all non-digits first avoids that.
      const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
      dest = filePath + '.' + ts + '.bak';
    }
    fs.copyFileSync(filePath, dest);
    console.log(`Backed up to: ${dest}`);
  }
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
}

export function getOpenCodeProviders(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    // Malformed opencode.json is non-fatal: fall back to no discovered
    // providers (parity with the PowerShell impl) rather than aborting the tool.
    console.warn(`\x1b[33mWarning: could not parse ${filePath}; ignoring discovered providers\x1b[0m`);
    return {};
  }
  if (!config.provider) return {};
  const providers = {};
  for (const [name, data] of Object.entries(config.provider)) {
    if (data.models) {
      providers[name] = Object.keys(data.models).sort();
    }
  }
  return providers;
}

export function splitModelName(fullName) {
  const idx = fullName.lastIndexOf('/');
  if (idx === -1) return { provider: '', model: fullName };
  return { provider: fullName.substring(0, idx), model: fullName.substring(idx + 1) };
}

export function getAllModels(config) {
  const models = {};
  for (const [name, agent] of Object.entries(config.agents || {})) {
    const add = (modelName) => {
      if (!modelName) return;
      const parts = splitModelName(modelName);
      const key = parts.provider + '/' + parts.model;
      if (!models[key]) models[key] = parts;
    };
    add(agent.model);
    if (agent.fallback_models) {
      agent.fallback_models.forEach(add);
    }
  }
  return models;
}

export function getProviders(allModels) {
  const providers = {};
  for (const entry of Object.values(allModels)) {
    if (!entry.provider) continue;
    if (!providers[entry.provider]) providers[entry.provider] = [];
    if (!providers[entry.provider].includes(entry.model)) {
      providers[entry.provider].push(entry.model);
    }
  }
  return providers;
}

export function mergeProviderModels(swarmProviders, openCodeProviders) {
  const merged = { ...swarmProviders };
  for (const [key, models] of Object.entries(openCodeProviders)) {
    if (merged[key]) {
      merged[key] = [...new Set([...merged[key], ...models])].sort();
    } else {
      merged[key] = [...models];
    }
  }
  return merged;
}
