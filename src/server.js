const path = require('path');
const express = require('express');
const http = require('http');
const multer = require('multer');
const fs = require('fs-extra');
const cors = require('cors');
const { spawn } = require('child_process');
const { Server } = require('socket.io');
const OpenAI = require('openai');
const PROMPTS = require('./config/prompts');

const PORT = Number(process.env.PORT || 6769);
const ROOT_DIR = path.resolve(__dirname, '..');
const WORKSPACE_DIR = path.join(ROOT_DIR, 'workspace');
const UPLOAD_DIR = path.join(WORKSPACE_DIR, 'uploads');
const RUNS_DIR = path.join(WORKSPACE_DIR, 'runs');
const DECOMPILER_JAR = process.env.DECOMPILER_JAR || 'vineflower.jar';
const AI_MODEL = process.env.OPENAI_MODEL || 'gpt-5';
const MAX_BATCH_FILES = Number(process.env.MAX_BATCH_FILES || 8);
const MAX_CORRECTION_RETRIES = Number(process.env.MAX_CORRECTION_RETRIES || 2);
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(ROOT_DIR, 'public')));

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    await fs.ensureDir(UPLOAD_DIR);
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const safeName = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    cb(null, safeName);
  }
});
const upload = multer({ storage });

const runState = new Map();

function emitLog(runId, message, level = 'info', extra = {}) {
  const payload = { runId, timestamp: new Date().toISOString(), level, message, ...extra };
  io.to(runId).emit('status', payload);
  const state = runState.get(runId);
  if (state) {
    state.logs.push(payload);
  }
}

function ensureRun(runId) {
  if (!runState.has(runId)) {
    runState.set(runId, { logs: [], paths: {}, meta: {} });
  }
  return runState.get(runId);
}

async function initializeRun(meta) {
  const runId = `run-${Date.now()}`;
  const baseDir = path.join(RUNS_DIR, runId);
  const paths = {
    baseDir,
    decompiledDir: path.join(baseDir, 'decompiled'),
    pseudoDir: path.join(baseDir, 'pseudo-code-midman'),
    generatedDir: path.join(baseDir, 'generated-project'),
    correctionsDir: path.join(baseDir, 'self-corrections')
  };
  await Promise.all(Object.values(paths).map((dir) => fs.ensureDir(dir)));
  runState.set(runId, { logs: [], paths, meta });
  return { runId, paths };
}

function runCommand(command, args, options, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false });
    const handle = (stream, level) => {
      let buffer = '';
      stream.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        lines.filter(Boolean).forEach((line) => onLine(line, level));
      });
      stream.on('end', () => {
        if (buffer.trim()) onLine(buffer.trim(), level);
      });
    };
    handle(child.stdout, 'info');
    handle(child.stderr, 'warn');
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function decompileJar(runId, jarPath, decompiledDir) {
  emitLog(runId, `Starting decompile for ${path.basename(jarPath)} with ${DECOMPILER_JAR}`);
  await runCommand('java', ['-jar', DECOMPILER_JAR, jarPath, decompiledDir], { cwd: ROOT_DIR }, (line, level) => {
    emitLog(runId, `[decompiler] ${line}`, level);
  });
  emitLog(runId, 'Decompile phase completed');
}

async function collectJavaFiles(dir) {
  const files = await fs.readdir(dir);
  const collected = [];
  for (const file of files) {
    const full = path.join(dir, file);
    const stat = await fs.stat(full);
    if (stat.isDirectory()) {
      collected.push(...(await collectJavaFiles(full)));
    } else if (file.endsWith('.java')) {
      collected.push(full);
    }
  }
  return collected;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function callAiJson(messages, responseFormat = { type: 'json_object' }) {
  if (!openai) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  const response = await openai.chat.completions.create({
    model: AI_MODEL,
    messages,
    response_format: responseFormat
  });
  return response.choices[0].message.content;
}

async function pseudoCodePhase(runId, decompiledDir, pseudoDir, meta) {
  const javaFiles = await collectJavaFiles(decompiledDir);
  emitLog(runId, `Pseudo-code extraction queued for ${javaFiles.length} Java files`);
  const chunks = chunkArray(javaFiles, MAX_BATCH_FILES);
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const batch = chunks[chunkIndex];
    emitLog(runId, `Processing pseudo-code batch ${chunkIndex + 1}/${chunks.length}`);
    for (const filePath of batch) {
      const source = await fs.readFile(filePath, 'utf8');
      const relativePath = path.relative(decompiledDir, filePath);
      const userPrompt = `Convert this decompiled source into exhaustive architectural pseudo-code for a ${meta.projectType} being ported from Minecraft ${meta.sourceVersion} to ${meta.targetVersion}.\n\nFile: ${relativePath}\n\nSource:\n\n${source}`;
      const markdown = openai
        ? await callAiJson([
          { role: 'system', content: PROMPTS.pseudoCodeSystem },
          { role: 'user', content: JSON.stringify({ relativePath, requestedOutput: 'markdown', prompt: userPrompt }) }
        ], { type: 'json_object' })
        : JSON.stringify({ markdown: `# ${relativePath}\n\nOpenAI is not configured. Replace this placeholder with AI-generated pseudo-code.` }, null, 2);
      const parsed = JSON.parse(markdown);
      const pseudoPath = path.join(pseudoDir, `${relativePath}.md`);
      await fs.ensureDir(path.dirname(pseudoPath));
      await fs.writeFile(pseudoPath, parsed.markdown || parsed.content || markdown, 'utf8');
      emitLog(runId, `Pseudo-code written: ${path.relative(ROOT_DIR, pseudoPath)}`);
    }
  }
  emitLog(runId, 'Pseudo-code extraction phase completed');
}

async function readPseudoCodeBundle(pseudoDir) {
  const files = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const stat = await fs.stat(full);
      if (stat.isDirectory()) await walk(full);
      else files.push(full);
    }
  }
  await walk(pseudoDir);
  const bundle = [];
  for (const file of files) {
    bundle.push({ path: path.relative(pseudoDir, file), content: await fs.readFile(file, 'utf8') });
  }
  return bundle;
}

async function generateProject(runId, pseudoDir, generatedDir, meta, compilerFeedback = null) {
  emitLog(runId, compilerFeedback ? 'Requesting AI self-correction pass' : 'Generating target project from pseudo-code');
  const pseudoBundle = await readPseudoCodeBundle(pseudoDir);
  let payload;
  if (openai) {
    const schemaPrompt = {
      projectType: meta.projectType,
      sourceVersion: meta.sourceVersion,
      targetVersion: meta.targetVersion,
      outputSchema: {
        files: [{ path: 'relative/path', content: 'file body' }],
        notes: ['important migration note']
      },
      pseudoCodeFiles: pseudoBundle,
      compilerFeedback
    };
    const raw = await callAiJson([
      { role: 'system', content: PROMPTS.finalCodeSystem },
      { role: 'user', content: JSON.stringify(schemaPrompt) }
    ]);
    payload = JSON.parse(raw);
  } else {
    payload = {
      files: [
        {
          path: 'README.md',
          content: '# Generated project placeholder\n\nConfigure OPENAI_API_KEY to enable AI project reconstruction.'
        }
      ],
      notes: ['OpenAI not configured; generated placeholder project only.']
    };
  }

  await fs.emptyDir(generatedDir);
  for (const file of payload.files || []) {
    const destination = path.join(generatedDir, file.path);
    await fs.ensureDir(path.dirname(destination));
    await fs.writeFile(destination, file.content, 'utf8');
  }
  await fs.writeJson(path.join(generatedDir, 'generation-notes.json'), payload.notes || [], { spaces: 2 });
  emitLog(runId, `Generated ${payload.files?.length || 0} files for target project`);
}

function resolveBuildCommand(projectDir) {
  if (fs.existsSync(path.join(projectDir, 'gradlew'))) {
    return process.platform === 'win32'
      ? { cmd: 'cmd', args: ['/c', 'gradlew.bat', 'build'] }
      : { cmd: 'bash', args: ['./gradlew', 'build'] };
  }
  if (fs.existsSync(path.join(projectDir, 'pom.xml'))) {
    return { cmd: 'mvn', args: ['package'] };
  }
  return null;
}

async function compileProject(runId, generatedDir, meta) {
  const build = resolveBuildCommand(generatedDir);
  if (!build) {
    throw new Error('No Gradle wrapper or pom.xml found in generated project');
  }
  const jdkHome = process.env[`JDK_${String(meta.targetVersion).replace(/[^0-9]/g, '_')}`] || process.env.DEFAULT_JDK_HOME;
  const env = { ...process.env };
  if (jdkHome) {
    env.JAVA_HOME = jdkHome;
    env.PATH = `${path.join(jdkHome, 'bin')}${path.delimiter}${env.PATH}`;
  }
  let output = '';
  await runCommand(build.cmd, build.args, { cwd: generatedDir, env }, (line, level) => {
    output += `${line}\n`;
    emitLog(runId, `[build] ${line}`, level);
  });
  return output;
}

async function compileWithSelfCorrection(runId, generatedDir, pseudoDir, meta) {
  for (let attempt = 0; attempt <= MAX_CORRECTION_RETRIES; attempt += 1) {
    try {
      emitLog(runId, `Compile attempt ${attempt + 1}/${MAX_CORRECTION_RETRIES + 1}`);
      await compileProject(runId, generatedDir, meta);
      emitLog(runId, 'Compilation succeeded');
      return;
    } catch (error) {
      emitLog(runId, `Compilation failed: ${error.message}`, 'error');
      if (attempt === MAX_CORRECTION_RETRIES) throw error;
      await generateProject(runId, pseudoDir, generatedDir, meta, { attempt: attempt + 1, error: error.message });
    }
  }
}

app.post('/api/upload', upload.single('jarFile'), async (req, res) => {
  try {
    const meta = {
      projectType: req.body.projectType || 'mod',
      sourceVersion: req.body.sourceVersion || 'unknown',
      targetVersion: req.body.targetVersion || 'unknown',
      jarPath: req.file.path,
      originalName: req.file.originalname
    };
    const run = await initializeRun(meta);
    res.json({ runId: run.runId, file: req.file.filename, meta });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/run/:runId/decompile', async (req, res) => {
  const { runId } = req.params;
  const state = ensureRun(runId);
  try {
    await decompileJar(runId, state.meta.jarPath, state.paths.decompiledDir);
    res.json({ ok: true, phase: 'decompile' });
  } catch (error) {
    emitLog(runId, error.message, 'error');
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/run/:runId/pseudocode', async (req, res) => {
  const { runId } = req.params;
  const state = ensureRun(runId);
  try {
    await pseudoCodePhase(runId, state.paths.decompiledDir, state.paths.pseudoDir, state.meta);
    res.json({ ok: true, phase: 'pseudocode' });
  } catch (error) {
    emitLog(runId, error.message, 'error');
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/run/:runId/generate', async (req, res) => {
  const { runId } = req.params;
  const state = ensureRun(runId);
  try {
    await generateProject(runId, state.paths.pseudoDir, state.paths.generatedDir, state.meta);
    res.json({ ok: true, phase: 'generate' });
  } catch (error) {
    emitLog(runId, error.message, 'error');
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/run/:runId/compile', async (req, res) => {
  const { runId } = req.params;
  const state = ensureRun(runId);
  try {
    await compileWithSelfCorrection(runId, state.paths.generatedDir, state.paths.pseudoDir, state.meta);
    res.json({ ok: true, phase: 'compile' });
  } catch (error) {
    emitLog(runId, error.message, 'error');
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/run/:runId', (req, res) => {
  const state = ensureRun(req.params.runId);
  res.json(state);
});

io.on('connection', (socket) => {
  socket.on('join-run', (runId) => {
    socket.join(runId);
    const state = runState.get(runId);
    if (state) {
      state.logs.forEach((log) => socket.emit('status', log));
    }
  });
});

server.listen(PORT, async () => {
  await Promise.all([fs.ensureDir(UPLOAD_DIR), fs.ensureDir(RUNS_DIR)]);
  console.log(`BHsim AI Port Bridge listening on port ${PORT}`);
});
