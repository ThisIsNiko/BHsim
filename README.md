# BHsim AI Port Bridge

A foundational Node.js/Express application for porting Minecraft mod or plugin JARs through a two-stage AI pseudo-code bridge.

## Features
- Upload a JAR and declare mod/plugin mode plus source/target Minecraft versions.
- Decompile with Vineflower/Fernflower-compatible CLI execution.
- Extract exhaustive architectural pseudo-code into `workspace/runs/<runId>/pseudo-code-midman`.
- Regenerate a target project using a second AI pass with JSON file emission.
- Attempt Gradle or Maven compilation with configurable JDK homes and retry using AI self-correction.
- Stream live status messages to the browser with Socket.io.

## Environment variables
- `PORT` - defaults to `6769`.
- `OPENAI_API_KEY` - enables GPT/Codex calls.
- `OPENAI_MODEL` - defaults to `gpt-5`.
- `DECOMPILER_JAR` - path to the Vineflower/Fernflower JAR.
- `MAX_BATCH_FILES` - max Java files per AI batch.
- `MAX_CORRECTION_RETRIES` - compile self-correction retries.
- `DEFAULT_JDK_HOME` - fallback JDK for compilation.
- `JDK_<targetVersionDigits>` - version-specific JDK mapping, such as `JDK_1_20_4`.

## Run locally
```bash
npm install
npm start
```

Then open `http://localhost:6769`.
