const socket = io();
const uploadForm = document.getElementById('uploadForm');
const consoleLog = document.getElementById('consoleLog');
const runMeta = document.getElementById('runMeta');
const clearConsoleButton = document.getElementById('clearConsoleButton');
const phaseButtons = {
  decompile: document.getElementById('decompileButton'),
  pseudocode: document.getElementById('pseudoButton'),
  generate: document.getElementById('generateButton'),
  compile: document.getElementById('compileButton')
};

let runId = null;

function appendLog({ timestamp, level, message }) {
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  consoleLog.textContent += `${line}\n`;
  consoleLog.scrollTop = consoleLog.scrollHeight;
}

async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    body,
    headers: body instanceof FormData ? undefined : { 'Content-Type': 'application/json' }
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Request failed');
  }
  return response.json();
}

function setPhaseButtons(enabled) {
  Object.values(phaseButtons).forEach((button) => {
    button.disabled = !enabled;
  });
}

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(uploadForm);
  try {
    appendLog({ timestamp: new Date().toISOString(), level: 'info', message: 'Uploading JAR and initializing run...' });
    const data = await post('/api/upload', formData);
    runId = data.runId;
    socket.emit('join-run', runId);
    runMeta.textContent = `Run ${runId} | ${data.meta.projectType} | ${data.meta.sourceVersion} -> ${data.meta.targetVersion}`;
    setPhaseButtons(true);
    appendLog({ timestamp: new Date().toISOString(), level: 'info', message: `Run initialized: ${runId}` });
  } catch (error) {
    appendLog({ timestamp: new Date().toISOString(), level: 'error', message: error.message });
  }
});

Object.entries(phaseButtons).forEach(([phase, button]) => {
  button.addEventListener('click', async () => {
    if (!runId) return;
    try {
      appendLog({ timestamp: new Date().toISOString(), level: 'info', message: `Starting ${phase} phase...` });
      await post(`/api/run/${runId}/${phase}`);
      appendLog({ timestamp: new Date().toISOString(), level: 'info', message: `${phase} phase completed.` });
    } catch (error) {
      appendLog({ timestamp: new Date().toISOString(), level: 'error', message: `${phase} failed: ${error.message}` });
    }
  });
});

clearConsoleButton.addEventListener('click', () => {
  consoleLog.textContent = '';
});

socket.on('status', appendLog);
