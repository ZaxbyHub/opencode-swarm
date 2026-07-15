import { readSwarmConfig, writeSwarmConfig, getOpenCodeProviders, getAllModels, getProviders, mergeProviderModels, splitModelName } from './config.js';
import { selectFromList, ask, close } from './ui.js';

export async function runInteractive(swarmPath, openCodePath) {
  const config = readSwarmConfig(swarmPath);
  const swarmModels = getAllModels(config);
  const swarmProviders = getProviders(swarmModels);
  const openCodeProviders = getOpenCodeProviders(openCodePath);
  const allProviders = mergeProviderModels(swarmProviders, openCodeProviders);
  const agentNames = Object.keys(config.agents || {}).sort();

  if (agentNames.length === 0) {
    console.log('\x1b[31mNo agents configured\x1b[0m');
    close();
    process.exit(1);
  }

  console.log('');
  console.log('\x1b[36m=== Swarm Model Config Tool ===\x1b[0m');
  const provCount = Object.keys(allProviders).length;
  const provList = Object.keys(allProviders).join(', ');
  console.log(`\x1b[90mDetected ${provCount} providers (${provList})\x1b[0m`);

  let exitLoop = false;

  while (!exitLoop) {
    // Refresh config each iteration
    const cfg = readSwarmConfig(swarmPath);
    const sm = getAllModels(cfg);
    const sp = getProviders(sm);
    const oc = getOpenCodeProviders(openCodePath);
    const ap = mergeProviderModels(sp, oc);
    const an = Object.keys(cfg.agents || {}).sort();

    // Step 1: Select agent
    const agentLabels = an.map(n => `${n} | ${(cfg.agents[n]?.model || 'N/A')} | temp=${cfg.agents[n]?.temperature ?? 'N/A'}`);
    const selectedAgent = await selectFromList('Step 1: Select Agent to Configure', agentLabels, an);
    if (selectedAgent === '__quit__') { exitLoop = true; break; }

    const currentAgent = cfg.agents[selectedAgent];
    const currentModel = currentAgent.model || '';
    // Use the same splitter as the provider/model lists (lastIndexOf-based) so
    // the `[current]` marker matches, and guard against agents with no `model`
    // field (valid: an agent may set only temperature/disabled).
    const { provider: currentProvider, model: currentModelName } = splitModelName(currentModel);
    console.log(`\x1b[32mCurrent: ${selectedAgent} = ${currentModel || '(unset)'} (temp=${currentAgent.temperature ?? '(unset)'})\x1b[0m`);

    // Step 2: Select provider
    const providerNames = Object.keys(ap).sort();
    const providerLabels = providerNames.map(p => {
      const marker = p === currentProvider ? ' [current]' : '';
      return `${p} (${ap[p].length} models)${marker}`;
    });
    providerLabels.push('[Custom provider...]');
    const providerValues = [...providerNames, '__custom__'];

    let selectedProvider = await selectFromList('Step 2: Select Provider', providerLabels, providerValues);
    if (selectedProvider === '__quit__') { exitLoop = true; break; }

    if (selectedProvider === '__custom__') {
      let val = '';
      while (val === '') {
        val = await ask('Enter provider name: ');
        if (val.trim() === '') console.log('\x1b[31mProvider name cannot be empty\x1b[0m');
      }
      selectedProvider = val.trim();
    }

    // Step 3: Select model
    const providerModels = ap[selectedProvider] || [];
    let selectedModel;

    if (providerModels.length === 0) {
      let val = '';
      while (val === '') {
        val = await ask(`No models for ${selectedProvider}, enter model name: `);
        if (val.trim() === '') console.log('\x1b[31mModel name cannot be empty\x1b[0m');
      }
      selectedModel = val.trim();
    } else {
      const modelLabels = providerModels.map(m => {
        const marker = m === currentModelName && selectedProvider === currentProvider ? ' [current]' : '';
        return `${selectedProvider}/${m}${marker}`;
      });
      modelLabels.push('[Custom model...]');
      const modelValues = [...providerModels, '__custom__'];

      selectedModel = await selectFromList(`Step 3: Select Model (${selectedProvider})`, modelLabels, modelValues);
      if (selectedModel === '__quit__') { exitLoop = true; break; }

      if (selectedModel === '__custom__') {
        let val = '';
        while (val === '') {
          val = await ask('Enter model name: ');
          if (val.trim() === '') console.log('\x1b[31mModel name cannot be empty\x1b[0m');
        }
        selectedModel = val.trim();
      }
    }

    const fullModel = selectedProvider ? `${selectedProvider}/${selectedModel}` : selectedModel;

    // Step 4: Temperature
    console.log('');
    console.log('\x1b[36mStep 4: Temperature\x1b[0m');
    const currentTempDisplay = currentAgent.temperature ?? '(unset)';
    console.log(`Current: ${currentTempDisplay}`);
    const tempPrompt = `New temp (0.0-2.0, Enter to keep current [${currentTempDisplay}]): `;
    const tempInput = await ask(tempPrompt);
    let newTemp = currentAgent.temperature;
    if (tempInput.trim()) {
      const num = parseFloat(tempInput.trim());
      if (!isNaN(num) && num >= 0 && num <= 2) {
        newTemp = num;
      } else {
        console.log('\x1b[33mInvalid or out of range, keeping current\x1b[0m');
      }
    }

    // Step 5: Confirm
    console.log('');
    console.log('\x1b[36m=== Confirm ===\x1b[0m');
    console.log('  Agent:       ' + selectedAgent);
    console.log('  Model:       ' + (currentModel || '(unset)') + ' -> ' + fullModel);
    console.log('  Temperature: ' + (currentAgent.temperature ?? '(unset)') + ' -> ' + (newTemp ?? '(unset)'));
    console.log('');

    const confirm = await ask('Confirm? ([Y]/n): ');
    if (confirm.match(/^[nN]/)) {
      console.log('\x1b[33mCancelled\x1b[0m');
      continue;
    }

    cfg.agents[selectedAgent].model = fullModel;
    if (newTemp !== undefined) {
      cfg.agents[selectedAgent].temperature = newTemp;
    }
    writeSwarmConfig(cfg, swarmPath);

    console.log('');
    console.log('\x1b[32mConfig updated!\x1b[0m');
    console.log(`  ${selectedAgent} = ${fullModel} (temp=${newTemp ?? '(unset)'})`);
    console.log('');
    console.log('\x1b[33mNote: Restart opencode/swarm session to apply changes\x1b[0m');
    console.log('');

    // Continue or quit (selectFromList appends the quit option itself)
    const choice = await selectFromList('Next', ['Continue modifying another agent'], ['continue']);
    if (choice === '__quit__') {
      console.log('\x1b[36mGoodbye!\x1b[0m');
      exitLoop = true;
    }
  }

  close();
}
