const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { previewProjectOperation, executeProjectOperation, parseActionPlanResponse, inferSimpleActionPlan } = require('./electron/agent/projectActions.cjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-project-actions-'));
const project = path.join(base, 'project');
fs.mkdirSync(project);
async function run() {
try {
  fs.mkdirSync(path.join(project, 'src'));
  fs.writeFileSync(path.join(project, 'src', 'main.js'), 'before');
  fs.writeFileSync(path.join(project, 'notes.md'), 'notes');
  fs.writeFileSync(path.join(project, '.env'), 'SECRET=never-touch');

  // Natural-language planning for common actions is deterministic and doesn't
  // require the NVIDIA API to return correctly formatted JSON.
  let inferred = inferSimpleActionPlan('Rename this project to renamed-project', project);
  assert.equal(inferred.operation, 'rename_project');
  assert.equal(inferred.destinationPath, path.join(base, 'renamed-project'));
  const deterministicRequest = parseActionPlanResponse(JSON.stringify(inferSimpleActionPlan('Create a folder called verified-docs', project)), project);
  const deterministicPreview = previewProjectOperation(deterministicRequest);
  assert.equal(fs.existsSync(path.join(project, 'verified-docs')), false, 'natural-language preview must not change disk');
  const deterministicResult = await executeProjectOperation(deterministicPreview);
  assert.equal(deterministicResult.verified, true, 'natural-language plans must execute through the validated operation layer');
  assert.equal(fs.statSync(path.join(project, 'verified-docs')).isDirectory(), true);
  inferred = inferSimpleActionPlan('Create a folder called docs', project);
  assert.equal(inferred.operation, 'create_folder');
  assert.equal(inferred.destinationPath, path.join(project, 'docs'));
  inferred = inferSimpleActionPlan('Create a folder called components inside src', project);
  assert.equal(inferred.destinationPath, path.join(project, 'src', 'components'));
  inferred = inferSimpleActionPlan('Rename file notes.md to notes-old.md', project);
  assert.equal(inferred.operation, 'rename_path');
  assert.equal(inferred.sourcePath, path.join(project, 'notes.md'));
  assert.equal(inferred.destinationPath, path.join(project, 'notes-old.md'));
  inferred = inferSimpleActionPlan('Copy file notes.md to src', project);
  assert.equal(inferred.operation, 'copy_file');
  assert.equal(inferred.sourcePath, path.join(project, 'notes.md'));
  inferred = inferSimpleActionPlan('Move file notes.md into folder src', project);
  assert.equal(inferred.operation, 'move_path');
  assert.equal(inferred.destinationPath, path.join(project, 'src')); 
  inferred = inferSimpleActionPlan('Create file called draft.txt with content "hello"', project);
  assert.equal(inferred.operation, 'create_file');
  assert.equal(inferred.content, 'hello');
  inferred = inferSimpleActionPlan('Rename notes.md and move src/main.js to src/app.js', project);
  assert.equal(inferred.needsClarification, true, 'compound requests must not be mistaken for a single path');

  const parsedPlan = parseActionPlanResponse(JSON.stringify({
    operation: 'rename_path', sourcePath: 'notes.md', destinationPath: 'renamed-from-natural-language.md',
    explanation: 'Rename the selected note.', needsClarification: false,
  }), project);
  assert.equal(parsedPlan.sourcePath, path.join(project, 'notes.md'));
  assert.equal(parsedPlan.destinationPath, path.join(project, 'renamed-from-natural-language.md'));
  assert.throws(() => parseActionPlanResponse(JSON.stringify({ needsClarification: true, question: 'Which file?' }), project), /Which file/);
  assert.throws(() => parseActionPlanResponse(JSON.stringify({ operation: 'run_shell_command', sourcePath: 'notes.md' }), project), /does not map to one supported/);

  let preview = previewProjectOperation({ projectRoot: project, operation: 'rename_path', sourcePath: path.join(project, 'notes.md'), destinationPath: path.join(project, 'renamed.md') });
  assert.equal(fs.existsSync(path.join(project, 'renamed.md')), false, 'preview must not modify disk');
  let result = await executeProjectOperation(preview);
  assert.equal(result.verified, true);
  assert.equal(fs.readFileSync(path.join(project, 'renamed.md'), 'utf8'), 'notes');
  await assert.rejects(() => executeProjectOperation(preview), /does not exist|changed after preview/i, 'stale previews must not be replayable after the source path changes');

  preview = previewProjectOperation({ projectRoot: project, operation: 'edit_file', sourcePath: path.join(project, 'src', 'main.js'), content: 'after' });
  result = await executeProjectOperation(preview);
  assert.equal(result.verified, true);
  assert.equal(fs.readFileSync(path.join(project, 'src', 'main.js'), 'utf8'), 'after');
  assert.equal(fs.readFileSync(result.backupPath, 'utf8'), 'before');

  preview = previewProjectOperation({ projectRoot: project, operation: 'create_file', destinationPath: path.join(project, 'src', 'new.txt'), content: 'created' });
  result = await executeProjectOperation(preview);
  assert.equal(result.verified, true);
  assert.equal(fs.readFileSync(path.join(project, 'src', 'new.txt'), 'utf8'), 'created');

  assert.throws(() => previewProjectOperation({ projectRoot: project, operation: 'copy_file', sourcePath: path.join(project, '.env'), destinationPath: path.join(project, 'env-copy') }), /Sensitive files/);
  assert.throws(() => previewProjectOperation({ projectRoot: project, operation: 'rename_path', sourcePath: path.join(project, 'renamed.md'), destinationPath: path.join(base, 'outside.md') }), /remain inside|escapes/);
  assert.throws(() => previewProjectOperation({ projectRoot: project, operation: 'create_file', destinationPath: path.join(project, 'not-yet', 'new.txt'), content: 'x' }), /parent directory/);
  const copyTargetDir = path.join(project, 'copy-target');
  fs.mkdirSync(copyTargetDir);
  preview = previewProjectOperation({ projectRoot: project, operation: 'copy_file', sourcePath: path.join(project, 'renamed.md'), destinationPath: copyTargetDir });
  assert.equal(preview.destinationPath, path.join(copyTargetDir, 'renamed.md'), 'copying to an existing directory should preserve the source filename');
  result = await executeProjectOperation(preview);
  assert.equal(result.verified, true);
  assert.equal(fs.readFileSync(path.join(copyTargetDir, 'renamed.md'), 'utf8'), 'notes');

  preview = previewProjectOperation({ projectRoot: project, operation: 'rename_path', sourcePath: path.join(project, 'renamed.md'), destinationPath: path.join(project, 'renamed-again.md') });
  fs.writeFileSync(path.join(project, 'renamed.md'), 'changed after preview');
  await assert.rejects(() => executeProjectOperation(preview), /Source changed after preview/);

  preview = previewProjectOperation({ projectRoot: project, operation: 'trash_path', sourcePath: path.join(project, 'src', 'new.txt') });
  let trashedPath = null;
  result = await executeProjectOperation(preview, { trashItem: async targetPath => { trashedPath = targetPath; fs.unlinkSync(targetPath); } });
  assert.equal(result.recoverableViaRecycleBin, true);
  assert.equal(trashedPath, path.join(project, 'src', 'new.txt'));

  const target = path.join(base, 'project-renamed');
  preview = previewProjectOperation({ projectRoot: project, operation: 'rename_project', sourcePath: project, destinationPath: target });
  result = await executeProjectOperation(preview);
  assert.equal(result.verified, true);
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.existsSync(project), false);

  const projectForMove = path.join(base, 'move-me');
  const destinationFolder = path.join(base, 'destination-folder');
  fs.mkdirSync(projectForMove);
  fs.mkdirSync(destinationFolder);
  fs.writeFileSync(path.join(projectForMove, 'readme.md'), 'project');
  preview = previewProjectOperation({ projectRoot: projectForMove, operation: 'move_project', sourcePath: projectForMove, destinationPath: destinationFolder });
  assert.equal(preview.destinationPath, path.join(destinationFolder, 'move-me'), 'existing destination folder should mean move project into that folder');
  result = await executeProjectOperation(preview);
  assert.equal(result.verified, true);
  assert.equal(fs.readFileSync(path.join(destinationFolder, 'move-me', 'readme.md'), 'utf8'), 'project');

  console.log('PASS: project actions preview changes, validate natural-language action plans, reject unsupported actions, handle moves into existing folders, validate stale sources, block sensitive files and overwrites, back up edits, and verify results.');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
}
run().catch(error => { console.error(error); process.exitCode = 1; });
