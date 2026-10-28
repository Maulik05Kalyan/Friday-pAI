const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BLOCKED_NAMES = new Set(['.env', '.env.local', '.env.production', '.env.development', 'credentials.json', 'secrets.json', 'id_rsa', 'id_ed25519']);
const BLOCKED_EXTENSIONS = /\.(pem|key|p12|pfx)$/i;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function sensitive(p) {
  return path.resolve(p).split(path.sep).some(part => BLOCKED_NAMES.has(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part) || BLOCKED_EXTENSIONS.test(part));
}
function canonicalExisting(input, label = 'Path') {
  if (typeof input !== 'string' || !input.trim()) throw new Error(`${label} is required.`);
  const resolved = path.resolve(input.trim());
  if (!fs.existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
  const stats = fs.lstatSync(resolved);
  if (stats.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link.`);
  return fs.realpathSync(resolved);
}
function assertNoSymlinkTree(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const stats = fs.lstatSync(full);
    if (stats.isSymbolicLink()) throw new Error(`Operation refused because the project contains a symbolic link: ${full}`);
    if (stats.isDirectory()) assertNoSymlinkTree(full);
  }
}
function fingerprint(p) {
  const stat = fs.lstatSync(p);
  const base = `${stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other'}:${stat.size}:${stat.mtimeMs}:${stat.ino}`;
  if (stat.isFile() && stat.size <= MAX_TEXT_BYTES) return `${base}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
  return base;
}
function ensureExistingParent(target, label) {
  const parent = path.dirname(target);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new Error(`${label} parent directory must already exist: ${parent}`);
  if (fs.lstatSync(parent).isSymbolicLink()) throw new Error(`${label} parent cannot be a symbolic link.`);
  return fs.realpathSync(parent);
}

function stripOuterQuotes(value) {
  return String(value || '').trim().replace(/^["'`]/, '').replace(/["'`.,;!?]+$/, '').trim();
}

function resolveUserPath(root, value) {
  const cleaned = stripOuterQuotes(value);
  if (!cleaned) return '';
  return path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(root, cleaned);
}

// Deterministic parsing for common, explicit requests means basic file operations
// do not depend on the model returning perfectly formatted JSON. Ambiguous requests
// deliberately fall through to the AI planner/clarification path.
function inferSimpleActionPlan(instruction, projectRoot) {
  if (typeof instruction !== 'string' || !instruction.trim()) return null;
  const text = instruction.trim();
  const root = canonicalExisting(projectRoot, 'Selected project folder');
  const tail = (pattern) => {
    const match = text.match(pattern);
    return match ? stripOuterQuotes(match[1]) : '';
  };
  const plan = (operation, sourcePath, destinationPath, explanation, content) => ({
    operation, sourcePath, destinationPath, explanation,
    ...(content !== undefined ? { content, contentProvided: true } : {}),
  });

  // Never interpret a compound request as one malformed filename/path. The UI
  // executes one operation per explicit approval, so ask the user to split it.
  if (/\b(and then|then also|after that)\b/i.test(text) ||
      (/\b(and|also)\b/i.test(text) && (text.match(/\b(rename|move|copy|create|make|delete|remove|edit|update)\b/gi) || []).length > 1)) {
    return { needsClarification: true, question: 'I can safely execute one filesystem operation per approval. Please split this into separate requests, starting with the first operation.' };
  }

  // Whole project rename/move. A bare folder name for rename is interpreted as
  // a sibling folder; moving into an existing directory keeps the project name.
  let target = tail(/\b(?:rename|renam(?:e|ing))\s+(?:this\s+|the\s+)?(?:project(?:\s+(?:folder|name))?|project\s+folder|folder)\s+(?:to|as|named)\s+(.+)$/i);
  if (target) {
    const destination = path.isAbsolute(target) ? path.resolve(target) : path.join(path.dirname(root), target);
    return plan('rename_project', root, destination, 'Renaming the selected project folder.');
  }
  target = tail(/\bmove\s+(?:this\s+|the\s+|my\s+|selected\s+)?(?:project|project\s+folder)\s+(?:to|into)\s+(.+)$/i);
  if (target) return plan('move_project', root, resolveUserPath(root, target), 'Moving the selected project folder.');

  // Create a folder/directory.
  target = tail(/\b(?:create|make|add)\s+(?:a\s+)?(?:new\s+)?(?:folder|directory)\s+(?:called|named)\s+(.+)$/i)
    || tail(/\b(?:create|make)\s+(?:a\s+)?(?:new\s+)?(?:folder|directory)\s+([\w .()_-]+)$/i);
  if (target) {
    const nested = target.match(/^(.+?)\s+(?:inside|in|under)\s+(.+)$/i);
    const folderPath = nested ? path.join(resolveUserPath(root, nested[2]), stripOuterQuotes(nested[1])) : resolveUserPath(root, target);
    return plan('create_folder', null, folderPath, 'Creating a folder inside the selected project.');
  }

  // Create a file with explicitly supplied content.
  let match = text.match(/\b(?:create|make)\s+(?:a\s+)?(?:new\s+)?file\s+(?:called|named)\s+(.+?)\s+(?:with\s+content|containing)\s+["'`](.*?)["'`]\s*$/i);
  if (match) return plan('create_file', null, resolveUserPath(root, match[1]), 'Creating a text file with the supplied content.', match[2]);
  target = tail(/\b(?:create|make)\s+(?:a\s+)?(?:new\s+)?file\s+(?:called|named)\s+(.+)$/i);
  if (target) return { operation: 'create_file', destinationPath: resolveUserPath(root, target), explanation: 'A new file was requested, but no file content was supplied.', needsClarification: true, question: 'What text should I put in the new file? I will not create an empty file unless you explicitly ask for one.' };

  // Source + destination phrases. Quoted paths support spaces. Relative paths
  // are resolved from the selected project root, then the safety validator checks them.
  match = text.match(/\b(rename|move|copy)\s+(?:the\s+)?(?:file|folder|directory|item)?\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([\w.:/\\() -]+?))\s+(?:to|as|into)\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([\w.:/\\() -]+))\s*$/i);
  if (match) {
    const verb = match[1].toLowerCase();
    const sourceText = stripOuterQuotes(match[2] || match[3] || match[4] || match[5]);
    let destinationText = stripOuterQuotes(match[6] || match[7] || match[8] || match[9]);
    const sourcePath = resolveUserPath(root, sourceText);
    if (verb !== 'rename') {
      destinationText = destinationText.replace(/^(?:the\s+)?(?:new\s+)?(?:folder|directory)\s+(?:named|called)\s+/i, '')
        .replace(/^(?:the\s+)?(?:folder|directory)\s+/i, '')
        .replace(/\s+(?:folder|directory)$/i, '');
    }
    const destinationPath = resolveUserPath(root, destinationText);
    if (verb === 'copy') return plan('copy_file', sourcePath, destinationPath, `Copying ${sourceText} to ${destinationText}.`);
    if (verb === 'move') return plan('move_path', sourcePath, destinationPath, `Moving ${sourceText} to ${destinationText}.`);
    // A destination with no directory separator is a new name beside the source.
    const renameDestination = !path.isAbsolute(destinationText) && !destinationText.includes('/') && !destinationText.includes('\\')
      ? path.join(path.dirname(sourcePath), destinationText) : destinationPath;
    return plan('rename_path', sourcePath, renameDestination, `Renaming ${sourceText} to ${destinationText}.`);
  }

  target = tail(/\b(?:delete|remove|trash)\s+(?:the\s+)?(?:file|folder|directory|item)?\s*["'`]?(.+?)["'`]?\s*$/i);
  if (target && !/\b(memory|history|goal|workflow|project assistant)\b/i.test(target)) {
    return plan('trash_path', resolveUserPath(root, target), null, `Sending ${target} to the system Recycle Bin.`);
  }
  return null;
}

function parseActionPlanResponse(raw, projectRoot) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('The AI did not return a project action plan.');
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The AI response did not contain a valid action plan. Please rephrase the request.');
  let plan;
  try { plan = JSON.parse(text.slice(start, end + 1)); }
  catch { throw new Error('The AI returned malformed action JSON. Please rephrase the request.'); }
  if (plan.needsClarification) {
    throw new Error(String(plan.question || 'Please clarify the requested operation and exact target path.').slice(0, 500));
  }
  const allowed = new Set(['rename_project', 'move_project', 'rename_path', 'move_path', 'copy_file', 'create_folder', 'create_file', 'edit_file', 'trash_path']);
  if (!allowed.has(plan.operation)) throw new Error('This request does not map to one supported file operation. Choose a specific operation or use Project Assistant for analysis.');
  const root = canonicalExisting(projectRoot, 'Selected project folder');
  const operation = plan.operation;
  let sourcePath = plan.sourcePath ? String(plan.sourcePath).trim() : null;
  let destinationPath = plan.destinationPath ? String(plan.destinationPath).trim() : null;
  if (['rename_project', 'move_project'].includes(operation)) sourcePath = root;
  if (['rename_project', 'move_project', 'rename_path', 'move_path', 'copy_file', 'create_folder', 'create_file'].includes(operation) && !destinationPath) {
    throw new Error('The plan is missing the destination path. Please specify the full destination path.');
  }
  if (['rename_path', 'move_path', 'copy_file', 'edit_file', 'trash_path'].includes(operation) && !sourcePath) {
    throw new Error('The plan is missing the source path. Please specify the file or folder to operate on.');
  }
  if (destinationPath && !path.isAbsolute(destinationPath)) destinationPath = path.resolve(root, destinationPath);
  if (sourcePath && !path.isAbsolute(sourcePath)) sourcePath = path.resolve(root, sourcePath);
  const content = ['create_file', 'edit_file'].includes(operation) ? String(plan.content ?? '') : undefined;
  if (['create_file', 'edit_file'].includes(operation) && !plan.contentProvided && !content) {
    throw new Error('The request requires file content. Please provide the content or ask the assistant to draft it first.');
  }
  return {
    projectRoot: root,
    operation,
    sourcePath: sourcePath || undefined,
    destinationPath: destinationPath || undefined,
    content,
    explanation: String(plan.explanation || 'Prepared from your natural-language request.').slice(0, 500),
  };
}

function normalizeRequest(request) {
  if (!request || typeof request !== 'object') throw new Error('An operation request is required.');
  const projectRoot = canonicalExisting(request.projectRoot, 'Selected project folder');
  if (!fs.statSync(projectRoot).isDirectory()) throw new Error('Selected project path must be a directory.');
  const operation = String(request.operation || '');
  const allowed = new Set(['rename_project', 'move_project', 'rename_path', 'move_path', 'copy_file', 'create_folder', 'create_file', 'edit_file', 'trash_path']);
  if (!allowed.has(operation)) throw new Error('Unsupported project operation.');
  const sourceRequired = ['rename_project', 'move_project', 'rename_path', 'move_path', 'copy_file', 'edit_file', 'trash_path'].includes(operation);
  let sourcePath = null;
  if (sourceRequired) {
    sourcePath = canonicalExisting(request.sourcePath, 'Source path');
    if (sourcePath !== projectRoot && !inside(projectRoot, sourcePath)) throw new Error('Source must be the selected project folder or one of its descendants.');
    const sourceStats = fs.lstatSync(sourcePath);
    if (sourceStats.isSymbolicLink() || (!sourceStats.isFile() && !sourceStats.isDirectory())) throw new Error('Only regular files and directories can be operated on.');
    if (sourcePath !== projectRoot && sensitive(sourcePath)) throw new Error('Sensitive files cannot be renamed, copied, edited, or moved through Project Assistant.');
    if (sourcePath === projectRoot && !['rename_project', 'move_project'].includes(operation)) throw new Error('The selected project root can only be renamed or moved as a whole.');
    if (['copy_file', 'edit_file'].includes(operation) && !sourceStats.isFile()) throw new Error(`${operation} requires a regular file.`);
    if (operation === 'copy_file' && sensitive(sourcePath)) throw new Error('Sensitive files cannot be copied through Project Assistant.');
    if (operation === 'trash_path' && sourcePath === projectRoot) throw new Error('Moving the entire project to the Recycle Bin is not supported here. Select a file or subfolder.');
    if (operation === 'edit_file' && (sensitive(sourcePath) || sourceStats.size > MAX_TEXT_BYTES)) throw new Error('This file is sensitive or too large for safe text editing.');
    if (operation === 'edit_file' && fs.readFileSync(sourcePath).includes(0)) throw new Error('Binary files cannot be edited as text.');
  }
  let destinationPath = null;
  if (['rename_project', 'move_project', 'rename_path', 'move_path', 'copy_file', 'create_folder', 'create_file'].includes(operation)) {
    if (typeof request.destinationPath !== 'string' || !request.destinationPath.trim()) throw new Error('Destination path is required.');
    destinationPath = path.resolve(request.destinationPath.trim());
    // For whole-project moves, an existing directory means "move this project into that directory".
    // A non-existing path still means an explicit new full target path.
    if (operation === 'move_project' && fs.existsSync(destinationPath) && fs.statSync(destinationPath).isDirectory()) {
      destinationPath = path.join(destinationPath, path.basename(projectRoot));
    } else if (['move_path', 'copy_file'].includes(operation) && sourcePath && fs.existsSync(destinationPath) && fs.statSync(destinationPath).isDirectory()) {
      destinationPath = path.join(destinationPath, path.basename(sourcePath));
    }
    if (['create_folder', 'create_file'].includes(operation) && !inside(projectRoot, destinationPath)) throw new Error('New files and folders must be created inside the selected project.');
    if (['rename_path', 'move_path', 'copy_file'].includes(operation) && !inside(projectRoot, destinationPath)) throw new Error('File and folder destinations must remain inside the selected project. Use Move project to relocate the whole project folder.');
    const parent = ensureExistingParent(destinationPath, 'Destination');
    destinationPath = path.join(parent, path.basename(destinationPath));
    if (['create_folder', 'create_file', 'rename_path', 'move_path', 'copy_file'].includes(operation) && !inside(projectRoot, destinationPath)) {
      throw new Error('Resolved destination escapes the selected project folder.');
    }
    if (fs.existsSync(destinationPath)) throw new Error(`Destination already exists; overwriting is not allowed: ${destinationPath}`);
    if (sourcePath && (destinationPath === sourcePath || inside(sourcePath, destinationPath))) throw new Error('Destination cannot be the source itself or a child of the source.');
    if (['create_folder', 'create_file'].includes(operation) && sensitive(destinationPath)) throw new Error('Creating sensitive filenames is blocked.');
  }
  if (operation === 'edit_file') destinationPath = sourcePath;
  let content = null;
  if (['create_file', 'edit_file'].includes(operation)) {
    if (typeof request.content !== 'string') throw new Error('Text content is required.');
    if (Buffer.byteLength(request.content, 'utf8') > MAX_TEXT_BYTES) throw new Error('Text content exceeds the 5 MB safety limit.');
    content = request.content;
  }
  if (operation === 'rename_project' && path.dirname(destinationPath) !== path.dirname(projectRoot)) {
    throw new Error('Rename project changes only the project folder name. Use Move project to change its parent directory.');
  }
  if (['rename_project', 'move_project'].includes(operation) && path.basename(destinationPath).toLowerCase() === 'windows') throw new Error('Refusing to use a protected system-folder name.');
  return { operation, projectRoot, sourcePath, destinationPath, content };
}
function previewProjectOperation(request) {
  const normalized = normalizeRequest(request);
  const { operation, projectRoot, sourcePath, destinationPath, content } = normalized;
  const isRoot = sourcePath === projectRoot;
  const sourceFingerprint = sourcePath ? fingerprint(sourcePath) : null;
  const contentHash = content === null ? null : crypto.createHash('sha256').update(content).digest('hex');
  const descriptions = {
    rename_project: 'Rename the selected project folder', move_project: 'Move the selected project folder',
    rename_path: 'Rename a file or folder', move_path: 'Move a file or folder within the project', trash_path: 'Move a file or folder to the system Recycle Bin',
    copy_file: 'Copy a file within the project', create_folder: 'Create a folder', create_file: 'Create a new text file', edit_file: 'Replace the contents of a text file',
  };
  let caution = 'No changes have been made yet.';
  if (['move_project', 'rename_project', 'move_path', 'rename_path'].includes(operation)) caution = 'The original path will no longer exist after a successful operation.';
  if (operation === 'trash_path') caution = 'The selected item will be sent to the system Recycle Bin, where it may be recoverable.';
  if (operation === 'edit_file') caution = 'The existing file will be replaced. A backup copy will be created beside it first.';
  return {
    request: normalized,
    summary: descriptions[operation],
    sourcePath,
    destinationPath,
    projectRoot,
    sourceFingerprint,
    contentHash,
    caution,
    previewText: content === null ? undefined : content,
    requiresExplicitApproval: true,
  };
}
function copyTree(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not copied: ${source}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { mode: stat.mode });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) copyTree(path.join(source, entry.name), path.join(destination, entry.name));
  } else if (stat.isFile()) {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  } else throw new Error(`Unsupported filesystem entry: ${source}`);
}
function removeTree(p) {
  const stat = fs.lstatSync(p);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const name of fs.readdirSync(p)) removeTree(path.join(p, name));
    fs.rmdirSync(p);
  } else fs.unlinkSync(p);
}
async function treeManifest(root) {
  const entries = [];
  async function visit(current, relative = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const rel = path.posix.join(relative.split(path.sep).join('/'), entry.name);
      const stats = fs.lstatSync(full);
      if (stats.isSymbolicLink()) throw new Error(`Cross-volume move refuses symbolic links: ${full}`);
      if (stats.isDirectory()) {
        entries.push({ path: rel, type: 'directory' });
        await visit(full, rel);
      } else if (stats.isFile()) {
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(full)) hash.update(chunk);
        entries.push({ path: rel, type: 'file', size: stats.size, hash: hash.digest('hex') });
      } else throw new Error(`Unsupported filesystem entry: ${full}`);
    }
  }
  await visit(root);
  return entries;
}

async function executeProjectOperation(preview, options = {}) {
  if (!preview || !preview.request) throw new Error('A valid operation preview is required.');
  const fresh = normalizeRequest(preview.request);
  if (fresh.projectRoot !== preview.projectRoot || fresh.sourcePath !== preview.sourcePath || fresh.destinationPath !== preview.destinationPath) throw new Error('Operation paths changed after preview. Build a new preview.');
  if (fresh.sourcePath && fingerprint(fresh.sourcePath) !== preview.sourceFingerprint) throw new Error('Source changed after preview. Review a fresh preview before proceeding.');
  if (fresh.content !== null && crypto.createHash('sha256').update(fresh.content).digest('hex') !== preview.contentHash) throw new Error('Content changed after preview. Build a new preview.');
  if (fresh.destinationPath && fresh.destinationPath !== fresh.sourcePath && fs.existsSync(fresh.destinationPath)) throw new Error('Destination appeared after preview; refusing to overwrite.');
  const { operation, sourcePath, destinationPath, content, projectRoot } = fresh;
  if (operation === 'trash_path') {
    if (typeof options.trashItem !== 'function') throw new Error('System Recycle Bin support is unavailable in this context.');
    await options.trashItem(sourcePath);
    if (fs.existsSync(sourcePath)) throw new Error('The item was sent to the Recycle Bin request, but still exists at its original path. Verify the filesystem before retrying.');
    return { success: true, operation, sourcePath, verified: true, recoverableViaRecycleBin: true };
  }
  if (operation === 'create_folder') fs.mkdirSync(destinationPath);
  else if (operation === 'create_file') fs.writeFileSync(destinationPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  else if (operation === 'edit_file') {
    const backup = `${sourcePath}.friday-backup-${Date.now()}`;
    fs.copyFileSync(sourcePath, backup, fs.constants.COPYFILE_EXCL);
    try { fs.writeFileSync(sourcePath, content, { encoding: 'utf8', flag: 'w', mode: 0o600 }); }
    catch (error) { try { fs.copyFileSync(backup, sourcePath); } catch {} throw error; }
    const verified = fs.readFileSync(sourcePath, 'utf8') === content;
    if (!verified) throw new Error(`Edited file could not be verified. Backup retained at ${backup}`);
    return { success: true, operation, path: sourcePath, backupPath: backup, verified };
  } else if (operation === 'copy_file') fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
  else if (['rename_project', 'move_project', 'rename_path', 'move_path'].includes(operation)) {
    try { fs.renameSync(sourcePath, destinationPath); }
    catch (error) {
      if (error.code !== 'EXDEV' || !fs.statSync(sourcePath).isDirectory()) throw error;
      const sourceManifest = await treeManifest(sourcePath);
      try {
        copyTree(sourcePath, destinationPath);
        const destinationManifest = await treeManifest(destinationPath);
        if (JSON.stringify(sourceManifest) !== JSON.stringify(destinationManifest)) {
          throw new Error('Destination verification did not match the source project.');
        }
      } catch (copyError) {
        try { if (fs.existsSync(destinationPath)) removeTree(destinationPath); } catch (cleanupError) {
          copyError.message += ` Cleanup warning: partial destination remains at ${destinationPath}: ${cleanupError.message}`;
        }
        throw new Error(`Cross-volume project copy was not verified; the original was preserved. ${copyError.message}`);
      }
      try { removeTree(sourcePath); }
      catch (removeError) { throw new Error(`A verified copy exists at ${destinationPath}, but cleanup of the original was incomplete. Check both locations before retrying. Details: ${removeError.message}`); }
    }
  }
  const verified = operation === 'create_folder' ? fs.statSync(destinationPath).isDirectory()
    : operation === 'create_file' || operation === 'copy_file' ? fs.existsSync(destinationPath)
      : ['rename_project', 'move_project', 'rename_path', 'move_path'].includes(operation) ? fs.existsSync(destinationPath) && !fs.existsSync(sourcePath)
        : false;
  if (!verified) throw new Error('The operation ran but its final state could not be verified. Inspect both paths before retrying.');
  return { success: true, operation, sourcePath, destinationPath, verified: true, projectRootChanged: ['rename_project', 'move_project'].includes(operation) };
}
module.exports = { previewProjectOperation, executeProjectOperation, parseActionPlanResponse, inferSimpleActionPlan };
